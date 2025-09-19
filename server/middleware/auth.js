const { hasValidSessionToken } = require('../utils/session-tokens');

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    if (hasValidSessionToken(req)) {
      return next();
    }
    return res.status(401).json({ error: 'Authentication required' });
  }
  return res.status(401).json({ error: 'Authentication required' });
}

module.exports = {
  requireAdmin,
};
