const mongoose = require('mongoose');
const { logger } = require('./logger');

function installProcessHandlers() {
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandledRejection (process kept alive)', { err });
  });

  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException (process kept alive)', { err });
  });
}

function installMongoEventLogging() {
  const conn = mongoose.connection;
  conn.on('connected', () => logger.info('mongoose connected'));
  conn.on('disconnected', () => logger.warn('mongoose disconnected'));
  conn.on('reconnected', () => logger.info('mongoose reconnected'));
  conn.on('error', (err) => {
    logger.error('mongoose connection error', { err });
  });
}

module.exports = { installProcessHandlers, installMongoEventLogging };
