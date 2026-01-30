const winston = require('winston');
const path = require('path');

/**
 * Sensitive data patterns to redact from logs
 */
const SENSITIVE_PATTERNS = [
  /(?:"password"\s*[:=]|\bpassword\s*=)\s*([^",\s}]+)/gi,
  /token["\s:=]+([^",\s}]+)/gi,
  /secret["\s:=]+([^",\s}]+)/gi,
  /authorization["\s:]+bearer\s+([^\s"]+)/gi,
  /api[_-]?key["\s:=]+([^",\s}]+)/gi,
  /client[_-]?secret["\s:=]+([^",\s}]+)/gi,
];

/**
 * Redact sensitive data from log messages
 * @param {string} message - The log message to sanitize
 * @returns {string} Sanitized message
 */
function redactSensitiveData(message) {
  if (typeof message !== 'string') {
    return message;
  }

  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match, capture) => {
      return match.replace(capture, '[REDACTED]');
    });
  }

  return sanitized;
}

/**
 * Custom format for redacting sensitive data
 */
const redactFormat = winston.format((info) => {
  if (info.message) {
    info.message = redactSensitiveData(info.message);
  }

  // Redact in metadata objects
  if (info.meta && typeof info.meta === 'object') {
    info.meta = JSON.parse(redactSensitiveData(JSON.stringify(info.meta)));
  }

  return info;
});

/**
 * Create Winston logger instance
 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} ${level} ${message}${metaStr}`;
        })
      ),
    }),
  ],
  // Don't exit on uncaught errors
  exitOnError: false,
});

// Add file transport in production
if (process.env.NODE_ENV === 'production') {
  const logDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

  logger.add(
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    })
  );

  logger.add(
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    })
  );
}

/**
 * Backward compatibility wrapper functions
 */
function log(...args) {
  logger.info(args.join(' '));
}

function info(...args) {
  logger.info(args.join(' '));
}

function warn(...args) {
  logger.warn(args.join(' '));
}

function error(...args) {
  logger.error(args.join(' '));
}

function debug(...args) {
  logger.debug(args.join(' '));
}

module.exports = {
  logger, // Export Winston logger instance
  log,
  info,
  warn,
  error,
  debug,
};
