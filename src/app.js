const path = require('path');
const express = require('express');
const cors = require('cors');
const { ADMIN_WEB_DIR } = require('./config');
const { errorHandler } = require('./middleware/errorHandler');
const { logger } = require('./logger');

const { router: healthRouter } = require('./routes/health');
const { router: authRouter } = require('./routes/auth');
const { router: adminAuthRouter } = require('./routes/adminAuth');
const { router: adminUsersRouter } = require('./routes/adminUsers');
const { router: adminReportsRouter } = require('./routes/adminReports');
const { router: adminBackupsRouter } = require('./routes/adminBackups');
const { router: verificationsRouter } = require('./routes/verifications');
const { router: mediaRouter } = require('./routes/media');
const { router: roomRouter } = require('./routes/room');
const { router: safetyRouter } = require('./routes/safety');
const { router: invitationsRouter } = require('./routes/invitations');
const { router: tablesRouter } = require('./routes/tables');

function createExpressApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '15mb' }));
  app.use('/admin', express.static(ADMIN_WEB_DIR));

  app.use(healthRouter);
  app.use(authRouter);
  app.use(adminAuthRouter);
  app.use(adminUsersRouter);
  app.use(mediaRouter);
  app.use(verificationsRouter);
  app.use(roomRouter);
  app.use(safetyRouter);
  app.use(adminReportsRouter);
  app.use(invitationsRouter);
  app.use(tablesRouter);
  app.use(adminBackupsRouter);

  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
      logger.warn('bad request body', {
        path: req.originalUrl,
        message: err.message,
      });
      if (!res.headersSent) {
        return res.status(400).json({ error: 'Invalid request body' });
      }
    }
    return errorHandler(err, req, res, next);
  });

  return app;
}

module.exports = { createExpressApp };
