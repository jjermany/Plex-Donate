const path = require('path');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const config = require('./config');
const adminRouter = require('./routes/admin');
const webhookRouter = require('./routes/webhook');
const shareRouter = require('./routes/share');
const logger = require('./utils/logger');

const app = express();

app.set('trust proxy', 1);

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.sessionCookieSecure,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

app.use(bodyParser.urlencoded({ extended: false }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/paypal/webhook', webhookRouter);
app.use('/api/admin', adminRouter);
app.use('/api/share', shareRouter);

app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/share.html'));
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  logger.error('Unhandled error', err);
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  logger.info(`Plex Donate server listening on port ${config.port}`);
});

module.exports = app;
