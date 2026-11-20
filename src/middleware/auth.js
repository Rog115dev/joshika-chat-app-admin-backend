const { adminSessions } = require('../lib/tokens');
const { authUser } = require('../services/users');

function requireAdmin(req, res) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !adminSessions.has(match[1])) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return match[1];
}

async function requireApprovedUser(req, res) {
  const user = await authUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  if (String(user.verificationStatus || '').toLowerCase() !== 'approved') {
    res.status(403).json({ error: 'Identity verification required' });
    return null;
  }
  return user;
}

module.exports = { requireAdmin, requireApprovedUser };
