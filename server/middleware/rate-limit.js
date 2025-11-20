const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

/**
 * Rate limiter for authentication endpoints
 * Prevents brute force attacks on login
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: {
    error: 'Too many login attempts. Please try again later.',
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip} on ${req.path}`);
    res.status(429).json({
      error: 'Too many login attempts. Please try again in 15 minutes.',
    });
  },
  skip: (req) => {
    // Skip rate limiting in test environment
    return process.env.NODE_ENV === 'test';
  },
});

/**
 * Rate limiter for email verification endpoints
 * Prevents abuse of email sending
 */
const emailVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Limit each IP to 3 requests per hour
  message: {
    error: 'Too many verification requests. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`Email verification rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many verification requests. Please try again in 1 hour.',
    });
  },
  skip: (req) => {
    return process.env.NODE_ENV === 'test';
  },
});

/**
 * Rate limiter for webhook endpoints
 * Prevents webhook flooding
 */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per minute
  message: {
    error: 'Too many webhook requests. Please slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`Webhook rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Rate limit exceeded',
    });
  },
  skip: (req) => {
    return process.env.NODE_ENV === 'test';
  },
});

/**
 * General API rate limiter
 * Prevents general API abuse
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`API rate limit exceeded for IP: ${req.ip} on ${req.path}`);
    res.status(429).json({
      error: 'Too many requests. Please slow down.',
    });
  },
  skip: (req) => {
    return process.env.NODE_ENV === 'test';
  },
});

module.exports = {
  authLimiter,
  emailVerificationLimiter,
  webhookLimiter,
  apiLimiter,
};
