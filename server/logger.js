'use strict';

const pino = require('pino');
const crypto = require('crypto');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
});

/**
 * Express middleware: assigns a unique requestId to each request.
 */
function requestIdMiddleware(req, _res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  req.log = logger.child({ requestId: req.id });
  next();
}

module.exports = { logger, requestIdMiddleware };
