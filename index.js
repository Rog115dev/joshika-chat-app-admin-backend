const {
  PORT,
  HOST,
  MONGODB_URI,
  ADMIN_EMAIL,
  BACKUP_DIR,
  HEALTH_LOG_INTERVAL_SEC,
} = require('./src/config');
const { logger } = require('./src/logger');
const { connectMongo, syncCountersFromData } = require('./src/db');
const { ensureBackupDir } = require('./src/lib/backup');
const {
  backfillApprovedSelfies,
  ensureDemoUsers,
} = require('./src/services/users');
const {
  formatHostStatusLines,
  primeCpuSample,
} = require('./src/services/health');
const { createExpressApp } = require('./src/app');
const {
  installProcessHandlers,
  installMongoEventLogging,
} = require('./src/processSafety');

installProcessHandlers();

async function startHostMetrics() {
  const tick = () => {
    try {
      logger.status('Host status', formatHostStatusLines());
    } catch (err) {
      logger.warn('host metrics failed', { message: err?.message || err });
    }
  };
  try {
    // Two samples ~250ms apart so first log already has CPU % (incl. Windows)
    await primeCpuSample(250);
  } catch (_) {
    /* ignore */
  }
  tick();
  const timer = setInterval(tick, HEALTH_LOG_INTERVAL_SEC * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

async function start() {
  try {
    ensureBackupDir();
    installMongoEventLogging();
    await connectMongo(MONGODB_URI);
    await syncCountersFromData();
    const selfieBackfill = await backfillApprovedSelfies();
    if (selfieBackfill) {
      logger.info('Backfilled approved selfie → profileImageUrl', {
        count: selfieBackfill,
      });
    }
    await ensureDemoUsers();

    const app = createExpressApp();
    app.listen(PORT, HOST, () => {
      logger.info('Joshikai API listening', {
        url: `http://${HOST}:${PORT}`,
      });
      logger.info('Admin web', { url: `http://${HOST}:${PORT}/admin/` });
      logger.info('MongoDB', {
        uri: MONGODB_URI.replace(/\/\/.*@/, '//***@'),
      });
      logger.info('Backup dir', { path: BACKUP_DIR });
      logger.info('Admin login', {
        email: ADMIN_EMAIL,
        password: '(see ADMIN_PASSWORD env)',
      });
      logger.info('Host metrics interval', {
        seconds: HEALTH_LOG_INTERVAL_SEC,
      });
      startHostMetrics();
    });
  } catch (err) {
    logger.error('Failed to start server', { err });
    process.exit(1);
  }
}

start();
