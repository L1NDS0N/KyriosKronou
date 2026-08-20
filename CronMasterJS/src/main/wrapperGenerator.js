// wrapperGenerator.js - Generates PowerShell wrapper scripts for NSSM service management
// The wrapper stays alive as a long-running process (required by NSSM)
// It checks the cron schedule periodically and spawns the user's script as a subprocess

const fs = require('fs');
const path = require('path');

class WrapperGenerator {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.wrappersDir = path.join(config.configDir, 'wrappers');
    if (!fs.existsSync(this.wrappersDir)) {
      fs.mkdirSync(this.wrappersDir, { recursive: true });
    }
  }

  generateWrapper(task) {
    const wrapperPath = path.join(this.wrappersDir, `task-${task.Id}.ps1`);
    const logDir = path.join(this.config.configDir, '..', 'logs');
    const logPath = path.join(logDir, `task-${task.Id}.log`);

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const taskName = task.Name.replace(/"/g, '""');
    const scriptPath = task.ScriptPath;
    const args = task.Arguments || '';
    const workDir = task.WorkingDirectory || path.dirname(task.ScriptPath);
    const isBat = /\.(bat|cmd)$/i.test(scriptPath);

    const cronParts = task.CronExpression.trim().split(/\s+/);
    const cronMinute = cronParts[0] || '*';
    const cronHour = cronParts[1] || '*';
    const cronDay = cronParts[2] || '*';
    const cronMonth = cronParts[3] || '*';
    const cronDow = cronParts[4] || '*';

    // NOTE: All strings are ASCII-only to avoid PowerShell 5.1 encoding issues.
    // PS5.1 reads .ps1 as ANSI/Windows-1252 unless the file has a UTF-8 BOM.
    // Characters like em-dash (U+2014) break when read as Windows-1252.
    const wrapper = [
      '# ============================================================',
      '# CronMaster NSSM Wrapper Script',
      '# Task: ' + taskName,
      '# ID: ' + task.Id,
      '# Cron: ' + task.CronExpression,
      '# Generated: ' + new Date().toISOString(),
      '# Mode: nssm (service managed by NSSM, keeps process alive)',
      '# ============================================================',
      '#',
      '# HOW THIS WORKS:',
      '# - NSSM starts this PowerShell script as a Windows service',
      '# - NSSM requires the main process to STAY ALIVE',
      '# - This script runs an infinite loop checking the cron schedule',
      '# - When the schedule matches, it spawns the user script as a subprocess',
      '# - The subprocess runs independently and can take as long as needed',
      '# - After the subprocess finishes, the loop continues checking',
      '# - The wrapper logs everything to the task log file',
      '# ============================================================',
      '',
      '$ErrorActionPreference = "Continue"',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      '',
      '# --- Configuration ---',
      '$TaskId = "' + task.Id + '"',
      '$TaskName = "' + taskName + '"',
      '$ScriptPath = "' + scriptPath.replace(/"/g, '""') + '"',
      '$ScriptArgs = "' + args.replace(/"/g, '""') + '"',
      '$WorkDir = "' + workDir.replace(/"/g, '""') + '"',
      '$LogFile = "' + logPath.replace(/"/g, '""') + '"',
      '$IsBatScript = ' + (isBat ? '$true' : '$false'),
      '',
      '# Cron fields',
      '$CronMinute = "' + cronMinute + '"',
      '$CronHour = "' + cronHour + '"',
      '$CronDay = "' + cronDay + '"',
      '$CronMonth = "' + cronMonth + '"',
      '$CronDow = "' + cronDow + '"',
      '',
      '# --- Logging ---',
      'function Write-Log {',
      '    param([string]$Level, [string]$Message)',
      '    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"',
      '    $entry = "[$timestamp] [$Level] $Message"',
      '    try { Add-Content -Path $LogFile -Value $entry -ErrorAction SilentlyContinue } catch {}',
      '}',
      '',
      '# --- Cron Matching ---',
      'function Test-CronMatch {',
      '    param([string]$Field, [int]$CurrentValue)',
      '    if ($Field -eq "*") { return $true }',
      '    if ($Field -match "^\\*/(\\d+)$") {',
      '        $step = [int]$Matches[1]',
      '        if ($step -eq 0) { return $false }',
      '        return ($CurrentValue % $step -eq 0)',
      '    }',
      '    if ($Field -match "^(\\d+)-(\\d+)$") {',
      '        return ($CurrentValue -ge [int]$Matches[1] -and $CurrentValue -le [int]$Matches[2])',
      '    }',
      '    if ($Field -match ",") {',
      '        $values = $Field -split "," | ForEach-Object { [int]$_.Trim() }',
      '        return ($values -contains $CurrentValue)',
      '    }',
      '    try { return ($CurrentValue -eq [int]$Field) } catch { return $false }',
      '}',
      '',
      'function Test-ShouldRun {',
      '    $now = Get-Date',
      '    $result = $true',
      '    $result = $result -and (Test-CronMatch -Field $CronMinute -CurrentValue $now.Minute)',
      '    $result = $result -and (Test-CronMatch -Field $CronHour -CurrentValue $now.Hour)',
      '    $result = $result -and (Test-CronMatch -Field $CronDay -CurrentValue $now.Day)',
      '    $result = $result -and (Test-CronMatch -Field $CronMonth -CurrentValue $now.Month)',
      '    $result = $result -and (Test-CronMatch -Field $CronDow -CurrentValue $([int]$now.DayOfWeek))',
      '    return $result',
      '}',
      '',
      '# --- Execute User Script as Subprocess ---',
      'function Invoke-UserScript {',
      '    $startTime = Get-Date',
      '    Write-Log "INFO" "--- Executing script: $ScriptPath ---"',
      '',
      '    if (-not (Test-Path $ScriptPath)) {',
      '        Write-Log "ERROR" "Script file not found: $ScriptPath"',
      '        return',
      '    }',
      '',
      '    try {',
      '        $pinfo = New-Object System.Diagnostics.ProcessStartInfo',
      '',
      '        # .bat/.cmd files must be run via cmd.exe /c',
      '        if ($IsBatScript) {',
      '            $pinfo.FileName = "cmd.exe"',
      '            $batArgs = "/c `"$ScriptPath`""',
      '            if ($ScriptArgs) { $batArgs = $batArgs + " " + $ScriptArgs }',
      '            $pinfo.Arguments = $batArgs',
      '        } else {',
      '            $pinfo.FileName = $ScriptPath',
      '            if ($ScriptArgs) { $pinfo.Arguments = $ScriptArgs }',
      '        }',
      '',
      '        if ($WorkDir -and (Test-Path $WorkDir)) { $pinfo.WorkingDirectory = $WorkDir }',
      '        $pinfo.UseShellExecute = $false',
      '        $pinfo.RedirectStandardOutput = $true',
      '        $pinfo.RedirectStandardError = $true',
      '        $pinfo.CreateNoWindow = $true',
      '',
      '        $process = [System.Diagnostics.Process]::Start($pinfo)',
      '',
      '        # Read output asynchronously to prevent deadlocks',
      '        $stdoutTask = $process.StandardOutput.ReadToEndAsync()',
      '        $stderrTask = $process.StandardError.ReadToEndAsync()',
      '        $process.WaitForExit()',
      '',
      '        $stdout = $stdoutTask.Result',
      '        $stderr = $stderrTask.Result',
      '        $duration = ((Get-Date) - $startTime).TotalSeconds',
      '',
      '        if ($process.ExitCode -eq 0) {',
      '            Write-Log "INFO" ("Script completed OK in " + [math]::Round($duration, 1) + "s (exit 0)")',
      '            if ($stdout -and $stdout.Trim().Length -gt 0) {',
      '                $truncated = if ($stdout.Length -gt 1000) { $stdout.Substring(0, 1000) + "..." } else { $stdout }',
      '                Write-Log "INFO" "Output: $truncated"',
      '            }',
      '        } else {',
      '            Write-Log "ERROR" ("Script failed with exit code " + $process.ExitCode + " in " + [math]::Round($duration, 1) + "s")',
      '            if ($stderr -and $stderr.Trim().Length -gt 0) {',
      '                $truncated = if ($stderr.Length -gt 1000) { $stderr.Substring(0, 1000) + "..." } else { $stderr }',
      '                Write-Log "ERROR" "Error output: $truncated"',
      '            }',
      '        }',
      '    } catch {',
      '        Write-Log "ERROR" ("Exception: " + $_.Exception.Message)',
      '        Write-Log "ERROR" ("Stack: " + $_.ScriptStackTrace)',
      '    }',
      '',
      '    Write-Log "INFO" "--- Script execution finished ---"',
      '}',
      '',
      '# ============================================================',
      '# MAIN SERVICE LOOP',
      '# NSSM keeps this process alive. We check the cron schedule',
      '# every 15 seconds and spawn the user script when due.',
      '# ============================================================',
      'Write-Log "INFO" "========================================="',
      'Write-Log "INFO" ("NSSM Service STARTED: " + $TaskName)',
      'Write-Log "INFO" ("PID: " + $PID)',
      'Write-Log "INFO" ("Cron: " + $CronMinute + " " + $CronHour + " " + $CronDay + " " + $CronMonth + " " + $CronDow)',
      'Write-Log "INFO" ("Script: " + $ScriptPath)',
      'if ($ScriptArgs) { Write-Log "INFO" ("Arguments: " + $ScriptArgs) }',
      'if ($WorkDir) { Write-Log "INFO" ("WorkDir: " + $WorkDir) }',
      'Write-Log "INFO" "Mode: NSSM Service (wrapper stays alive)"',
      'Write-Log "INFO" "========================================="',
      '',
      '$lastRunMinute = -1',
      '$checkCount = 0',
      '$checkInterval = 15  # seconds between schedule checks',
      '',
      'try {',
      '    while ($true) {',
      '        $checkCount++',
      '        $now = Get-Date',
      '',
      '        # Only match once per minute to avoid double-runs',
      '        if ($now.Minute -ne $lastRunMinute) {',
      '            if (Test-ShouldRun) {',
      '                Write-Log "INFO" ("Cron matched at " + $now.ToString("HH:mm:ss") + " -- executing script...")',
      '                Invoke-UserScript',
      '                $lastRunMinute = $now.Minute',
      '            }',
      '        }',
      '',
      '        # Sleep between checks (efficient but responsive)',
      '        Start-Sleep -Seconds $checkInterval',
      '    }',
      '} catch {',
      '    Write-Log "ERROR" ("Main loop crashed: " + $_.Exception.Message)',
      '    Write-Log "ERROR" ("Stack: " + $_.ScriptStackTrace)',
      '} finally {',
      '    Write-Log "INFO" ("NSSM Service STOPPED: " + $TaskName + " (PID: " + $PID + ", ran " + $checkCount + " checks)")',
      '}'
    ].join('\r\n');

    // Write with UTF-8 BOM so PowerShell 5.1 reads the file as UTF-8
    // instead of the system default ANSI codepage
    const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
    const contentBuffer = Buffer.from(wrapper, 'utf8');
    fs.writeFileSync(wrapperPath, Buffer.concat([BOM, contentBuffer]));

    this.logger.log('INFO', `Generated NSSM wrapper for task '${task.Name}' at ${wrapperPath}`);

    return {
      wrapperPath,
      serviceName: `CronMaster_${task.Id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20)}`
    };
  }

  removeWrapper(taskId) {
    const wrapperPath = path.join(this.wrappersDir, `task-${taskId}.ps1`);
    if (fs.existsSync(wrapperPath)) {
      fs.unlinkSync(wrapperPath);
      this.logger.log('INFO', `Removed wrapper for task ${taskId}`);
    }
  }

  getWrapperPath(taskId) {
    return path.join(this.wrappersDir, `task-${taskId}.ps1`);
  }

  listWrappers() {
    if (!fs.existsSync(this.wrappersDir)) return [];
    return fs.readdirSync(this.wrappersDir)
      .filter(f => f.startsWith('task-') && f.endsWith('.ps1'))
      .map(f => ({
        file: f,
        taskId: f.replace('task-', '').replace('.ps1', ''),
        path: path.join(this.wrappersDir, f)
      }));
  }
}

module.exports = WrapperGenerator;
