// src/utils/logger.js
//
// Structured logging, replacing scattered console.log/console.error
// calls. Pretty-printed in development, plain JSON in
// production/staging so log aggregators (Datadog, CloudWatch, Loki,
// etc.) can parse it. Every log line carries a `service` field so
// this app's logs are identifiable once you're aggregating logs from
// more than one service.

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  base: { service: 'swiftpay' },
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
      },
});

module.exports = logger;
