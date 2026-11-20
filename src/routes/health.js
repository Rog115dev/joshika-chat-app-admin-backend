const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { collectHealth } = require('../services/health');
const { logger } = require('../logger');

const router = createAsyncRouter();

router.get('/health', async (_req, res) => {
  try {
    const health = await collectHealth();
    // Always 200 so uptime probes can distinguish process-up vs db-down via body.ok
    res.status(200).json(health);
  } catch (err) {
    logger.error('health check failed', { err });
    res.status(200).json({
      ok: false,
      mongo: false,
      error: 'Health check failed',
      selfieMedia: true,
      build: 'mongo-v1',
    });
  }
});

module.exports = { router };
