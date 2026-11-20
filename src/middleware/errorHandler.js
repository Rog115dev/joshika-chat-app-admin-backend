const { logger } = require('../logger');

function notFoundHandler(req, res, next) {
  if (res.headersSent) return next();
  res.status(404).json({ error: 'Not found' });
}

function errorHandler(err, req, res, _next) {
  const status = Number(err?.status || err?.statusCode) || 500;
  logger.requestError(req, err, { status });

  if (res.headersSent) return;

  const message =
    status >= 500
      ? 'Internal server error'
      : err?.message || 'Request failed';

  res.status(status).json({ error: message });
}

module.exports = { errorHandler, notFoundHandler };
