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
const ServiceManager = require('./serviceManager');
const WrapperGenerator = require('./wrapperGenerator');
const RunRegistry = require('./runRegistry');
const { SchedulerCore, ROLE_SERVICE, releaseOwnership } = require('./schedulerCore');
const ApiServer = require('./apiServer');

function bootstrap() {
  paths.ensureDirs();
  paths.migrateLegacyData();

  const logger = new Logger(paths.logsDir());
  const config = new ConfigManager(paths.configDir(), 'default');
  const cronParser = new CronParser();
  // O registro de execucoes vive aqui, e nao no app: quando o servidor esta
  // sem ninguem logado e o servico que executa, e so ele sabe o que esta rodando.
  const runs = new RunRegistry();
  const taskManager = new TaskManager(config, logger, cronParser, runs);
  const backupManager = new BackupManager(config, logger, runs);
  // O painel web tambem administra servicos do Windows, e no servidor ele e a
  // unica interface disponivel - passar null aqui deixaria metade dele morta.
  const serviceManager = new ServiceManager(logger, config);
  const wrapperGenerator = new WrapperGenerator(config, logger);

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

  // ─── Web interface ───
  // Hosted by the service, not the desktop app: on a server nobody is logged
  // in, so a web UI that only ran inside the GUI would be unreachable exactly
  // when it is most needed.
  let apiServer = null;
  if (config.getSetting('ApiEnabled', false)) {
    apiServer = new ApiServer(taskManager, config, logger, serviceManager, wrapperGenerator, backupManager, {
      runRegistry: runs, cronParser,
    });
    apiServer.start()
      .then((info) => logger.log('INFO', `Web interface listening on ${info.url} (bound to ${info.host})`))
      .catch((err) => logger.error('Web interface failed to start', err));
  } else {
    logger.log('INFO', 'Web interface disabled (enable it in the desktop app under Settings)');
  }

  const shutdown = (signal) => {
    logger.log('INFO', `Service stopping (${signal})`);
    logger.audit('SERVICE_STOPPED', { targetType: 'service', before: { pid: process.pid } });
    try { scheduler.stop(); } catch (e) {}
    if (apiServer) { try { apiServer.stop(); } catch (e) {} }
    try { runs.dispose(); } catch (e) {}
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

  return { scheduler, logger, taskManager, backupManager, config, apiServer };
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
