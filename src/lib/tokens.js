const crypto = require('crypto');

/** @type {Map<string, number>} */
const userSessions = new Map();
/** @type {Map<string, string>} admin token -> email */
const adminSessions = new Map();
/** email -> { code, expiresAt } for password reset */
const passwordResetCodes = new Map();

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function clearUserSessions(userId) {
  for (const [tok, uid] of userSessions.entries()) {
    if (uid === userId) userSessions.delete(tok);
  }
}

module.exports = {
  userSessions,
  adminSessions,
  passwordResetCodes,
  newToken,
  clearUserSessions,
};
