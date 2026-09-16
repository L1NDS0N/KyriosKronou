// serviceScheduler.js - Windows Service entry point (headless).
//
// This process runs in session 0 under LocalSystem, with no desktop, no GPU and
// no logged-in user - that is the whole point: when the admin logs off the
// server, Windows kills their session but services keep running.
//
// It is launched as PLAIN NODE, not as an Electron app:
//
//   set ELECTRON_RUN_AS_NODE=1
//   KyriosChronos.exe <path>\serviceScheduler.js
//
// ELECTRON_RUN_AS_NODE turns the shipped Electron binary into a bare Node
// runtime, so there is no GPU/window initialisation to fail in session 0 and no
// separate Node.js install required on the server. Nothing here may
// `require('electron')`.

const fs = require('fs');
const path = require('path');

const paths = require('./paths');
const Logger = require('./logger');
const ConfigManager = require('./configManager');
const CronParser = require('./cronParser');
const TaskManager = require('./taskManager');
const BackupManager = require('./backupManager');
const { SchedulerCore, ROLE_SERVICE, releaseOwnership } = require('./schedulerCore');

function bootstrap() {
  paths.ensureDirs();
  paths.migrateLegacyData();

  const logger = new Logger(paths.logsDir());
  const config = new ConfigManager(paths.configDir(), 'default');
  const cronParser = new CronParser();
  const taskManager = new TaskManager(config, logger, cronParser);
  const backupManager = new BackupManager(config, logger);

  logger.log('INFO', '=== Κύριος Χρόνος service scheduler starting ===');
  logger.log('INFO', `PID ${process.pid} | node ${process.version} | data ${paths.dataDir()}`);
  logger.log('INFO', `Tasks loaded: ${taskManager.getAllTasks().length} | backup profiles: ${backupManager.getAllProfiles().length}`);
  logger.audit('SERVICE_STARTED', { targetType: 'service', after: { pid: process.pid, dataDir: paths.dataDir() } });

  // Liveness marker for the GUI's "service health" panel.
  const pidFile = path.join(paths.configDir(), 'service.pid');
  try { fs.writeFileSync(pidFile, String(process.pid), 'utf8'); } catch (e) {}

  const scheduler = new SchedulerCore(
    { taskManager, backupManager, cronParser, logger },
    ROLE_SERVICE
  ).start();

  const shutdown = (signal) => {
    logger.log('INFO', `Service stopping (${signal})`);
    logger.audit('SERVICE_STOPPED', { targetType: 'service', before: { pid: process.pid } });
    try { scheduler.stop(); } catch (e) {}
    try { fs.unlinkSync(pidFile); } catch (e) {}
    try { logger.flush(); } catch (e) {}
    process.exit(0);
  };

  // NSSM stops a service by sending Ctrl+C, then SIGTERM, then killing it.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // A service must never die on a stray error - log it and carry on.
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception in service', err);
    logger.flush();
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Unhandled rejection in service', err);
    logger.flush();
  });

  // Flush frequently. The GUI reads these files to show what the service did,
  // so buffered lines that never reach disk are invisible to the operator.
  setInterval(() => { try { logger.flush(); } catch (e) {} }, 10000);

  logger.log('INFO', 'Scheduler loop running (15s interval)');
  logger.flush();

  return { scheduler, logger, taskManager, backupManager, config };
}

// Only bootstrap when executed directly, so tests can require this file.
if (require.main === module) {
  try {
    bootstrap();
  } catch (err) {
    // Nothing is initialised yet, so write straight to a fallback log.
    try {
      const dir = paths.logsDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, 'service-bootstrap-error.log'),
        `[${new Date().toISOString()}] ${err.stack || err.message}\n`
      );
    } catch (e) {}
    console.error('Service bootstrap failed:', err);
    process.exit(1);
  }
}

module.exports = { bootstrap, releaseOwnership };
