const fs = require('fs');

const IMPORTS = {
  auth: `const bcrypt = require('bcryptjs');
const { User, Verification } = require('../models');
const { getNextId } = require('../db');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { str } = require('../lib/util');
const { userSessions, passwordResetCodes, newToken } = require('../lib/tokens');
const { RESEND_API_KEY } = require('../config');
const { logger } = require('../logger');
const { makeResetCode, sendPasswordResetEmail } = require('../services/mail');
const {
  findUserByEmail,
  findUserById,
  publicUser,
  authUser,
  profileFromBody,
} = require('../services/users');
`,
  adminAuth: `const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { str } = require('../lib/util');
const { adminSessions, newToken } = require('../lib/tokens');
const { ADMIN_EMAIL, ADMIN_PASSWORD } = require('../config');
`,
  adminUsers: `const bcrypt = require('bcryptjs');
const { User, Verification, Invitation, Table, Message } = require('../models');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireAdmin } = require('../middleware/auth');
const { str } = require('../lib/util');
const { clearUserSessions } = require('../lib/tokens');
const { normalizeImageUrl, applyApprovedSelfieToProfile, latestVerificationForUser } = require('../lib/images');
const { logger } = require('../logger');
const {
  findUserById,
  findUserByEmail,
  publicUser,
} = require('../services/users');
`,
  media: `const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { normalizeImageUrl, isUsableSelfieUrl, latestVerificationForUser, isPrivateHostname } = require('../lib/images');
const { findUserById } = require('../services/users');
const { logger } = require('../logger');
`,
  verifications: `const bcrypt = require('bcryptjs');
const { User, Verification } = require('../models');
const { getNextId } = require('../db');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireAdmin } = require('../middleware/auth');
const { str } = require('../lib/util');
const { userSessions, newToken } = require('../lib/tokens');
const { applyApprovedSelfieToProfile } = require('../lib/images');
const { logger } = require('../logger');
const {
  findUserByEmail,
  findUserById,
  profileFromBody,
  verificationWithUser,
} = require('../services/users');
`,
  room: `const { User } = require('../models');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireApprovedUser } = require('../middleware/auth');
const { str } = require('../lib/util');
const { logger } = require('../logger');
const {
  findUserById,
  isEitherBlocked,
  publicProfileAsync,
} = require('../services/users');
`,
  safety: `const { Report } = require('../models');
const { getNextId } = require('../db');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireApprovedUser } = require('../middleware/auth');
const { str } = require('../lib/util');
const { logger } = require('../logger');
const {
  findUserById,
  declinePendingInvitesBetween,
} = require('../services/users');
`,
  adminReports: `const { Report } = require('../models');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireAdmin } = require('../middleware/auth');
const { str } = require('../lib/util');
const { logger } = require('../logger');
const { findUserById } = require('../services/users');
`,
  invitations: `const { Invitation, Table, Message } = require('../models');
const { getNextId } = require('../db');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireApprovedUser } = require('../middleware/auth');
const { str } = require('../lib/util');
const { logger } = require('../logger');
const {
  findUserById,
  isEitherBlocked,
  invitationPayload,
} = require('../services/users');
`,
  tables: `const { Table, Message } = require('../models');
const { getNextId } = require('../db');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireApprovedUser } = require('../middleware/auth');
const { str } = require('../lib/util');
const { logger } = require('../logger');
const {
  findUserById,
  isEitherBlocked,
  tablePayload,
  messagePayload,
} = require('../services/users');
`,
  adminBackups: `const fs = require('fs');
const express = require('express');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireAdmin } = require('../middleware/auth');
const { logger } = require('../logger');
const {
  ensureBackupDir,
  backupFilenameFor,
  sanitizeBackupUploadName,
  uniqueBackupFilename,
  resolveBackupFile,
  encryptBackupPayload,
  loadBackupPayload,
  validateEncryptedBackupBuffer,
  buildBackupPayload,
  readBackupMeta,
  restoreFromBackupData,
  listBackupMetas,
} = require('../lib/backup');
`,
};

function transformBody(body) {
  let out = body.replace(/\bapp\./g, 'router.');
  out = out.replace(
    /console\.error\((['"])([^'"]+)\1,\s*err\)/g,
    "logger.error('$2', { err })",
  );
  out = out.replace(
    /console\.error\((['"])([^'"]+)\1:\s*e\.message \|\| e\)/g,
    "logger.error('$2', { message: e.message || e })",
  );
  out = out.replace(/console\.warn\(([^)]+)\)/g, 'logger.warn(String($1))');
  return out;
}

for (const name of Object.keys(IMPORTS)) {
  const raw = fs.readFileSync(`src/_extract/${name}.js`, 'utf8');
  const body = transformBody(raw);
  const file = `${IMPORTS[name]}
const router = createAsyncRouter();

${body}
module.exports = { router };
`;
  fs.writeFileSync(`src/routes/${name}.js`, file);
  console.log('wrote', name);
}
