const path = require('path');
const { loadEnv } = require('./loadEnv');

loadEnv();

function strEnv(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

const PORT = Number(process.env.PORT) || 4100;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@joshikai.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PUBLIC_API_BASE = (
  process.env.PUBLIC_API_BASE || `http://23.27.186.171:${PORT}`
).replace(/\/$/, '');
const RESEND_API_KEY = strEnv('RESEND_API_KEY');
const RESEND_FROM_EMAIL =
  strEnv('RESEND_FROM_EMAIL') || 'Joshikai <onboarding@resend.dev>';
const MONGODB_URI =
  strEnv('MONGODB_URI') || 'mongodb://127.0.0.1:27017/joshikai';
const BACKUP_DIR = path.join(__dirname, '..', 'backup');
const BACKUP_SECRET =
  strEnv('BACKUP_SECRET') || ADMIN_PASSWORD || 'joshikai-backup-key';
const HEALTH_LOG_INTERVAL_SEC = Math.max(
  10,
  Number.parseInt(strEnv('HEALTH_LOG_INTERVAL_SEC') || '60', 10) || 60,
);
const ROOT_DIR = path.join(__dirname, '..');
const ADMIN_WEB_DIR = path.join(ROOT_DIR, 'admin-web');

module.exports = {
  strEnv,
  PORT,
  HOST,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  PUBLIC_API_BASE,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  MONGODB_URI,
  BACKUP_DIR,
  BACKUP_SECRET,
  HEALTH_LOG_INTERVAL_SEC,
  ROOT_DIR,
  ADMIN_WEB_DIR,
};
