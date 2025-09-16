function timestamp() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(timestamp(), '-', ...args);
}

function info(...args) {
  log('[info]', ...args);
}

function warn(...args) {
  log('[warn]', ...args);
}

function error(...args) {
  log('[error]', ...args);
}

module.exports = {
  log,
  info,
  warn,
  error,
};
