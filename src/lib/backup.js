const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  User,
  Verification,
  Invitation,
  Table,
  Message,
  Report,
  Counter,
} = require('../models');
const { syncCountersFromData } = require('../db');
const { BACKUP_DIR, BACKUP_SECRET } = require('../config');
const { userSessions } = require('./tokens');
const { stripDocIds } = require('./util');
const { logger } = require('../logger');

const BACKUP_MAGIC = Buffer.from('JKBAK1');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function backupFilenameFor(iso) {
  const stamp = new Date(iso).toISOString().replace(/[:.]/g, '-');
  return `joshikai-backup-${stamp}`;
}

function isBackupFilename(name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.gitkeep' || base.startsWith('.')) return false;
  if (base.includes('.') || base.includes('/') || base.includes('\\')) return false;
  return true;
}

function sanitizeBackupUploadName(rawName, backedUpAt) {
  let base = path.basename(String(rawName || '').trim());
  while (/\.[A-Za-z0-9]{1,10}$/.test(base)) {
    base = base.replace(/\.[A-Za-z0-9]{1,10}$/, '');
  }
  base = base
    .replace(/[^\w\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (isBackupFilename(base)) return base;
  return backupFilenameFor(backedUpAt || new Date().toISOString());
}

function uniqueBackupFilename(preferredName) {
  let name = preferredName;
  let full = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(full)) return { filename: name, full };
  let i = 2;
  while (i < 1000) {
    name = `${preferredName}-${i}`;
    full = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(full)) return { filename: name, full };
    i += 1;
  }
  name = `${preferredName}-${Date.now()}`;
  return { filename: name, full: path.join(BACKUP_DIR, name) };
}

function resolveBackupFile(filename) {
  const base = path.basename(String(filename || ''));
  if (!isBackupFilename(base)) return null;
  const full = path.resolve(BACKUP_DIR, base);
  const root = path.resolve(BACKUP_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return { filename: base, full };
}

function backupKeyFromSalt(salt) {
  return crypto.scryptSync(BACKUP_SECRET, salt, 32);
}

function encryptBackupPayload(payload) {
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = backupKeyFromSalt(salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([BACKUP_MAGIC, salt, iv, tag, ciphertext]);
}

function hasBackupMagic(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= BACKUP_MAGIC.length &&
    buf.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)
  );
}

function fileHasBackupMagic(fullPath) {
  try {
    const fd = fs.openSync(fullPath, 'r');
    try {
      const hdr = Buffer.alloc(BACKUP_MAGIC.length);
      const n = fs.readSync(fd, hdr, 0, hdr.length, 0);
      return n === hdr.length && hdr.equals(BACKUP_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function decryptBackupBuffer(buf) {
  const minLen = BACKUP_MAGIC.length + 16 + 12 + 16;
  if (!hasBackupMagic(buf) || buf.length < minLen) {
    throw new Error('Not a Joshikai encrypted backup');
  }
  let offset = BACKUP_MAGIC.length;
  const salt = buf.subarray(offset, offset + 16);
  offset += 16;
  const iv = buf.subarray(offset, offset + 12);
  offset += 12;
  const tag = buf.subarray(offset, offset + 16);
  offset += 16;
  const ciphertext = buf.subarray(offset);
  const key = backupKeyFromSalt(salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function loadBackupPayload(fullPath) {
  const buf = fs.readFileSync(fullPath);
  return decryptBackupBuffer(buf);
}

function validateEncryptedBackupBuffer(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) {
    throw new Error('empty');
  }
  if (!hasBackupMagic(buf)) {
    throw new Error('magic');
  }
  const data = decryptBackupBuffer(buf);
  if (!data || typeof data !== 'object' || !Array.isArray(data.users)) {
    throw new Error('payload');
  }
  return data;
}

async function buildBackupPayload() {
  const [users, verifications, invitations, tables, messages, reports, counters] =
    await Promise.all([
      User.find().lean(),
      Verification.find().lean(),
      Invitation.find().lean(),
      Table.find().lean(),
      Message.find().lean(),
      Report.find().lean(),
      Counter.find().lean(),
    ]);
  const backedUpAt = new Date().toISOString();
  return {
    version: 1,
    backedUpAt,
    app: 'joshikai',
    counts: {
      users: users.length,
      verifications: verifications.length,
      invitations: invitations.length,
      tables: tables.length,
      messages: messages.length,
      reports: reports.length,
      counters: counters.length,
    },
    users: stripDocIds(users),
    verifications: stripDocIds(verifications),
    invitations: stripDocIds(invitations),
    tables: stripDocIds(tables),
    messages: stripDocIds(messages),
    reports: stripDocIds(reports),
    counters: (counters || []).map((c) => ({
      _id: c._id,
      seq: c.seq,
    })),
  };
}

function readBackupMeta(fullPath, filename) {
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let backedUpAt = null;
  let counts = null;
  let version = null;
  let valid = false;
  try {
    const data = loadBackupPayload(fullPath);
    if (data && typeof data === 'object') {
      valid = true;
      if (typeof data.backedUpAt === 'string' && data.backedUpAt) {
        backedUpAt = data.backedUpAt;
      }
      if (data.counts && typeof data.counts === 'object') {
        counts = data.counts;
      } else {
        counts = {
          users: Array.isArray(data.users) ? data.users.length : 0,
          verifications: Array.isArray(data.verifications)
            ? data.verifications.length
            : 0,
          invitations: Array.isArray(data.invitations)
            ? data.invitations.length
            : 0,
          tables: Array.isArray(data.tables) ? data.tables.length : 0,
          messages: Array.isArray(data.messages) ? data.messages.length : 0,
          reports: Array.isArray(data.reports) ? data.reports.length : 0,
        };
      }
      if (data.version != null) version = data.version;
    }
  } catch (err) {
    valid = false;
    logger.warn('backup meta decrypt failed', {
      filename,
      message: err?.message || String(err),
    });
  }

  return {
    filename,
    size: stat.size,
    fileModifiedAt: stat.mtime.toISOString(),
    backedUpAt: backedUpAt || stat.mtime.toISOString(),
    counts,
    version,
    valid,
  };
}

async function restoreFromBackupData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid backup file');
  }
  const users = Array.isArray(data.users) ? data.users : [];
  const verifications = Array.isArray(data.verifications)
    ? data.verifications
    : [];
  const invitations = Array.isArray(data.invitations) ? data.invitations : [];
  const tables = Array.isArray(data.tables) ? data.tables : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const reports = Array.isArray(data.reports) ? data.reports : [];
  const counters = Array.isArray(data.counters) ? data.counters : [];

  await Promise.all([
    User.deleteMany({}),
    Verification.deleteMany({}),
    Invitation.deleteMany({}),
    Table.deleteMany({}),
    Message.deleteMany({}),
    Report.deleteMany({}),
    Counter.deleteMany({}),
  ]);

  if (users.length) await User.insertMany(stripDocIds(users), { ordered: false });
  if (verifications.length) {
    await Verification.insertMany(stripDocIds(verifications), { ordered: false });
  }
  if (invitations.length) {
    await Invitation.insertMany(stripDocIds(invitations), { ordered: false });
  }
  if (tables.length) await Table.insertMany(stripDocIds(tables), { ordered: false });
  if (messages.length) {
    await Message.insertMany(stripDocIds(messages), { ordered: false });
  }
  if (reports.length) {
    await Report.insertMany(stripDocIds(reports), { ordered: false });
  }
  if (counters.length) {
    await Counter.insertMany(
      counters.map((c) => ({ _id: c._id, seq: Number(c.seq) || 0 })),
      { ordered: false },
    );
  } else {
    await syncCountersFromData();
  }

  userSessions.clear();

  return {
    users: users.length,
    verifications: verifications.length,
    invitations: invitations.length,
    tables: tables.length,
    messages: messages.length,
    reports: reports.length,
    counters: counters.length,
  };
}

function listBackupMetas() {
  ensureBackupDir();
  const names = fs.readdirSync(BACKUP_DIR);
  const items = [];
  for (const name of names) {
    if (!isBackupFilename(name)) continue;
    const resolved = resolveBackupFile(name);
    if (!resolved) continue;
    try {
      if (!fileHasBackupMagic(resolved.full)) continue;
      const meta = readBackupMeta(resolved.full, resolved.filename);
      if (meta) items.push(meta);
    } catch (err) {
      logger.warn('skipping unreadable backup file', {
        filename: name,
        message: err?.message || String(err),
      });
    }
  }
  items.sort((a, b) => String(b.backedUpAt).localeCompare(String(a.backedUpAt)));
  return items;
}

module.exports = {
  BACKUP_DIR,
  ensureBackupDir,
  backupFilenameFor,
  isBackupFilename,
  sanitizeBackupUploadName,
  uniqueBackupFilename,
  resolveBackupFile,
  encryptBackupPayload,
  decryptBackupBuffer,
  loadBackupPayload,
  validateEncryptedBackupBuffer,
  fileHasBackupMagic,
  buildBackupPayload,
  readBackupMeta,
  restoreFromBackupData,
  listBackupMetas,
};
