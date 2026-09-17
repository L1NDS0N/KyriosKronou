// systemMetrics.js - Windows resource sampling for the web monitor.
//
// Deliberately uses CIM/WMI classes rather than typeperf or Get-Counter:
// performance-counter NAMES are localised by Windows, so "\Processor(_Total)\%
// Processor Time" simply does not exist on a Portuguese or German server.
// Win32_PerfFormattedData_* property names are invariant, so the same code
// works on any locale - which matters because this ships to servers.
//
// One long-lived PowerShell process emits a JSON line per sample. Spawning a
// shell per sample would cost more CPU than the thing being measured.
//
// Electron-free: the Windows service loads this as plain Node.

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_INTERVAL_MS = 2000;
// 30 minutes of history at the default interval.
const DEFAULT_HISTORY = 900;

// Win32_PerfFormattedData_* exposes values already averaged per second, so no
// delta arithmetic is needed here.
const SAMPLER_PS = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$intervalMs = [int]$args[0]

while ($true) {
  try {
    $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" | Select-Object -First 1
    $osi = Get-CimInstance Win32_OperatingSystem
    $dsk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" | Select-Object -First 1
    $net = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface
    $vol = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"

    $volumes = @()
    foreach ($v in $vol) {
      $volumes += [pscustomobject]@{
        drive = $v.DeviceID
        label = $v.VolumeName
        total = [double]$v.Size
        free  = [double]$v.FreeSpace
      }
    }

    $sample = [pscustomobject]@{
      t            = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      cpuPct       = [double]$cpu.PercentProcessorTime
      memTotalB    = [double]$osi.TotalVisibleMemorySize * 1024
      memFreeB     = [double]$osi.FreePhysicalMemory * 1024
      diskReadBps  = [double]$dsk.DiskReadBytesPerSec
      diskWriteBps = [double]$dsk.DiskWriteBytesPerSec
      netRecvBps   = [double](($net | Measure-Object BytesReceivedPersec -Sum).Sum)
      netSentBps   = [double](($net | Measure-Object BytesSentPersec -Sum).Sum)
      volumes      = $volumes
    }

    Write-Output ($sample | ConvertTo-Json -Compress -Depth 4)
  } catch {
    Write-Output ('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
  }

  Start-Sleep -Milliseconds $intervalMs
}
`;

class SystemMetrics extends EventEmitter {
  constructor(logger, options = {}) {
    super();
    this.logger = logger;
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.maxHistory = options.maxHistory || DEFAULT_HISTORY;
    this.history = [];
    this.latest = null;
    this.child = null;
    this.scriptPath = null;
    this.stopped = false;
    this.lastError = null;
  }

  get supported() {
    return process.platform === 'win32';
  }

  start() {
    if (this.child || this.stopped) return this;
    if (!this.supported) {
      this.lastError = 'Resource monitoring requires Windows';
      return this;
    }

    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-metrics-'));
      this.scriptPath = path.join(dir, 'sampler.ps1');
      fs.writeFileSync(this.scriptPath, SAMPLER_PS, 'utf8');
    } catch (err) {
      this.lastError = `Could not write sampler script: ${err.message}`;
      this._log('ERROR', this.lastError);
      return this;
    }

    this.child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.scriptPath, String(this.intervalMs),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // PowerShell emits one JSON object per line.
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this._ingest(line);
      }
      if (buffer.length > 64 * 1024) buffer = ''; // never grow without bound
    });

    this.child.stderr.on('data', (chunk) => {
      const msg = chunk.toString('utf8').trim();
      if (msg) this._log('WARN', `Metrics sampler stderr: ${msg.slice(0, 300)}`);
    });

    this.child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      // The sampler should run forever; restart it if Windows kills it.
      this._log('WARN', `Metrics sampler exited (code ${code}) - restarting in 5s`);
      setTimeout(() => this.start(), 5000).unref?.();
    });

    this.child.on('error', (err) => {
      this.lastError = err.message;
      this._log('ERROR', `Metrics sampler failed to start: ${err.message}`);
    });

    this._log('INFO', `Resource monitor started (every ${this.intervalMs}ms)`);
    return this;
  }

  _ingest(line) {
    let data;
    try { data = JSON.parse(line); } catch (e) { return; }

    if (data.error) {
      this.lastError = data.error;
      return;
    }

    const volumes = Array.isArray(data.volumes) ? data.volumes
      : (data.volumes ? [data.volumes] : []);

    const sample = {
      t: data.t || Date.now(),
      cpuPct: round(clampPct(data.cpuPct), 1),
      memTotal: data.memTotalB || 0,
      memUsed: Math.max(0, (data.memTotalB || 0) - (data.memFreeB || 0)),
      memPct: data.memTotalB ? round(((data.memTotalB - data.memFreeB) / data.memTotalB) * 100, 1) : 0,
      diskRead: Math.max(0, data.diskReadBps || 0),
      diskWrite: Math.max(0, data.diskWriteBps || 0),
      netRecv: Math.max(0, data.netRecvBps || 0),
      netSent: Math.max(0, data.netSentBps || 0),
      volumes: volumes.map(v => ({
        drive: v.drive,
        label: v.label || '',
        total: v.total || 0,
        free: v.free || 0,
        used: Math.max(0, (v.total || 0) - (v.free || 0)),
        pct: v.total ? round(((v.total - v.free) / v.total) * 100, 1) : 0,
      })),
    };

    this.latest = sample;
    this.lastError = null;
    this.history.push(sample);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    this.emit('sample', sample);
  }

  /** Most recent sample, plus static host facts the charts label themselves with. */
  current() {
    return {
      supported: this.supported,
      running: !!this.child,
      error: this.lastError,
      sample: this.latest,
      host: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        cpuModel: (os.cpus()[0] || {}).model || 'unknown',
        cpuCount: os.cpus().length,
        totalMemory: os.totalmem(),
        uptime: os.uptime(),
      },
    };
  }

  /** Samples from the ring buffer, newest last. */
  getHistory(limit) {
    if (!limit || limit >= this.history.length) return this.history.slice();
    return this.history.slice(-limit);
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      try { this.child.kill(); } catch (e) {}
      this.child = null;
    }
    if (this.scriptPath) {
      try { fs.rmSync(path.dirname(this.scriptPath), { recursive: true, force: true }); } catch (e) {}
      this.scriptPath = null;
    }
  }

  _log(level, message) {
    if (this.logger && this.logger.log) this.logger.log(level, message);
  }
}

function round(n, places) {
  const f = Math.pow(10, places);
  return Math.round((Number(n) || 0) * f) / f;
}

function clampPct(n) {
  const v = Number(n) || 0;
  return Math.min(100, Math.max(0, v));
}

module.exports = SystemMetrics;
module.exports.DEFAULT_INTERVAL_MS = DEFAULT_INTERVAL_MS;
