const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {
  User,
  Verification,
  Invitation,
  Table,
  Message,
} = require('./models');
const {
  connectMongo,
  getNextId,
  migrateFromJsonIfEmpty,
  syncCountersFromData,
  stripMongoId,
} = require('./db');

function strEnv(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

/** Load local .env without an extra dependency (RESEND_API_KEY, etc.). */
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] == null) process.env[key] = val;
    }
  } catch (_) {}
})();

const PORT = Number(process.env.PORT) || 4100;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@joshikai.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
/** Public base used in profileImageUrl (phone app must reach this host). */
const PUBLIC_API_BASE = (
  process.env.PUBLIC_API_BASE || `http://23.27.186.171:${PORT}`
).replace(/\/$/, '');
/** Resend.com API key for password-reset emails (set via env / .env). */
const RESEND_API_KEY = strEnv('RESEND_API_KEY');
const RESEND_FROM_EMAIL =
  strEnv('RESEND_FROM_EMAIL') || 'Joshikai <onboarding@resend.dev>';
const MONGODB_URI =
  strEnv('MONGODB_URI') || 'mongodb://127.0.0.1:27017/joshikai';

/** @type {Map<string, number>} */
const userSessions = new Map();
/** @type {Map<string, string>} admin token -> email */
const adminSessions = new Map();
/** email -> { code, expiresAt } for password reset */
const passwordResetCodes = new Map();

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function messageCountForTable(tableId) {
  return Message.countDocuments({ tableId });
}

/** Trust Ladder from total sent+received messages in one table match. */
function trustLadderFromCount(count, isVerified) {
  const n = Math.max(0, Number(count) || 0);
  const verified = !!isVerified;
  let stage = 'Light';
  let level = 1;
  let nextStage = 'Medium';
  let nextThreshold = 20;
  if (n >= 30) {
    stage = 'Rich';
    level = 3;
    nextStage = null;
    nextThreshold = 30;
  } else if (n >= 20) {
    stage = 'Medium';
    level = 2;
    nextStage = 'Rich';
    nextThreshold = 30;
  }
  let badge = null;
  if (n >= 30) badge = 'gold';
  else if (n >= 20 && verified) badge = 'verified';

  return {
    stage,
    level,
    messageCount: n,
    nextStage,
    nextThreshold,
    isVerified: verified,
    badge,
  };
}

async function findUserById(id) {
  if (id == null || !Number.isFinite(Number(id))) return null;
  return User.findOne({ id: Number(id) });
}

async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return User.findOne({ email: normalized });
}

/** Best (highest message count) match ladder for a user — for Profile Expanded. */
async function bestTrustLadderForUser(user) {
  if (!user) {
    return trustLadderFromCount(0, false);
  }
  const isVerified =
    String(user.verificationStatus || '').toLowerCase() === 'approved';
  const myTables = await Table.find({
    $or: [{ hostUserId: user.id }, { guestUserId: user.id }],
  }).lean();
  let bestCount = 0;
  let bestTable = null;
  for (const t of myTables) {
    const c = await messageCountForTable(t.id);
    if (c > bestCount || (c === bestCount && bestTable == null)) {
      bestCount = c;
      bestTable = t;
    }
  }
  const ladder = trustLadderFromCount(bestCount, isVerified);
  if (bestTable) {
    ladder.tableId = bestTable.id;
    ladder.tableName = bestTable.name || '';
    const peerId =
      bestTable.hostUserId === user.id
        ? bestTable.guestUserId
        : bestTable.hostUserId;
    const peer = await findUserById(peerId);
    ladder.peerName = peer?.nickname || peer?.name || '';
  } else {
    ladder.tableId = null;
    ladder.tableName = '';
    ladder.peerName = '';
  }
  return ladder;
}

async function publicUser(user) {
  if (!user) return null;
  const plain = stripMongoId(user);
  const { passwordHash, passedUserIds, ...rest } = plain;
  const isVerified =
    String(user.verificationStatus || '').toLowerCase() === 'approved';
  return {
    ...rest,
    profileImageUrl: await effectiveProfileImageUrl(user),
    isVerified,
    trustLadder: await bestTrustLadderForUser(user),
  };
}

async function authUser(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const userId = userSessions.get(match[1]);
  if (!userId) return null;
  return findUserById(userId);
}

/** Normalize profile image URLs so browsers can render them. */
function normalizeImageUrl(raw) {
  let s = str(raw);
  if (!s) return '';
  s = s.replace(/^['"]+|['"]+$/g, '');
  if (s.startsWith('data:image')) return s;
  if (s.startsWith('//')) s = `https:${s}`;
  if (!/^https?:\/\//i.test(s) && /^[\w.-]+\.[a-z]{2,}/i.test(s)) {
    s = `https://${s}`;
  }
  return s;
}

function isUsableSelfieUrl(raw) {
  const s = normalizeImageUrl(raw);
  return s.startsWith('data:image') || /^https?:\/\//i.test(s);
}

async function latestVerificationForUser(user) {
  if (!user) return null;
  const email = String(user.email || '').toLowerCase();
  const query = {
    $or: [
      ...(email ? [{ email }] : []),
      ...(user.id != null ? [{ userId: user.id }] : []),
    ],
  };
  if (!query.$or.length) return null;
  return Verification.findOne(query).sort({ submittedAt: -1, id: -1 });
}

function selfieMediaUrl(userId) {
  return `${PUBLIC_API_BASE}/media/selfie/${userId}`;
}

async function hasApprovedSelfie(user) {
  if (!user) return false;
  if (String(user.verificationStatus || '').toLowerCase() !== 'approved') {
    return false;
  }
  const linked = await latestVerificationForUser(user);
  return isUsableSelfieUrl(linked?.selfieUrl);
}

/**
 * After admin approval, the selfie becomes the Profile / My Preference photo.
 * Clients get a stable HTTP URL (not a huge data: URI in every JSON payload).
 */
function applyApprovedSelfieToProfile(user, selfieUrl) {
  if (!user || !isUsableSelfieUrl(selfieUrl)) return false;
  user.profileImageUrl = selfieMediaUrl(user.id);
  return true;
}

/** Prefer approved selfie over leftover registration avatar URLs. */
async function effectiveProfileImageUrl(user) {
  if (!user) return '';
  if (await hasApprovedSelfie(user)) {
    return selfieMediaUrl(user.id);
  }
  return normalizeImageUrl(user.profileImageUrl);
}

/** One-time / startup repair for members already approved before selfie copy. */
async function backfillApprovedSelfies() {
  const approved = await User.find({ verificationStatus: 'approved' });
  let changed = 0;
  for (const user of approved) {
    if (!(await hasApprovedSelfie(user))) continue;
    const next = selfieMediaUrl(user.id);
    if (user.profileImageUrl === next) continue;
    user.profileImageUrl = next;
    await user.save();
    const linked = await latestVerificationForUser(user);
    if (linked) {
      linked.profileImageUrl = next;
      await linked.save();
    }
    changed += 1;
  }
  return changed;
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local')) return true;
  if (host === '0.0.0.0' || host === '::1') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function profileFromBody(body) {
  const interests = Array.isArray(body.interests)
    ? body.interests.map((x) => String(x))
    : [];
  return {
    email: str(body.email).toLowerCase(),
    password: String(body.password || ''),
    name: str(body.name),
    nickname: str(body.nickname),
    profileImageUrl: normalizeImageUrl(body.profileImageUrl),
    lifeStatus: str(body.lifeStatus) || 'student',
    age: Number.parseInt(String(body.age || '0'), 10) || 0,
    placeOfLiving: str(body.placeOfLiving),
    phoneNumber: str(body.phoneNumber),
    interests,
  };
}

async function verificationPayload(row, user) {
  const r = stripMongoId(row);
  return {
    id: r.id,
    userId: r.userId,
    phoneNumber: r.phoneNumber || user?.phoneNumber || '',
    selfieUrl: r.selfieUrl || '',
    status: r.status,
    submittedAt: r.submittedAt,
    adminNote: r.adminNote || '',
    email: r.email || user?.email || '',
    name: r.name || user?.name || '',
    nickname: r.nickname || user?.nickname || '',
    profileImageUrl: r.profileImageUrl || user?.profileImageUrl || '',
    lifeStatus: r.lifeStatus || user?.lifeStatus || '',
    age: r.age ?? user?.age ?? 0,
    placeOfLiving: r.placeOfLiving || user?.placeOfLiving || '',
    interests: r.interests || user?.interests || [],
    user: user ? await publicUser(user) : null,
  };
}

async function verificationWithUser(row) {
  let user = row.email ? await findUserByEmail(row.email) : null;
  if (!user && row.userId != null) {
    user = await findUserById(row.userId);
  }
  return verificationPayload(row, user);
}

function clearUserSessions(userId) {
  for (const [tok, uid] of userSessions.entries()) {
    if (uid === userId) userSessions.delete(tok);
  }
}

function publicProfile(user) {
  if (!user) return null;
  const isVerified =
    String(user.verificationStatus || '').toLowerCase() === 'approved';
  return {
    id: user.id,
    email: user.email,
    name: user.name || user.nickname || '',
    nickname: user.nickname || user.name || '',
    profileImageUrl: normalizeImageUrl(user.profileImageUrl),
    lifeStatus: user.lifeStatus || '',
    age: user.age || 0,
    placeOfLiving: user.placeOfLiving || '',
    phoneNumber: user.phoneNumber || '',
    interests: user.interests || [],
    bio: user.bio || '',
    verificationStatus: user.verificationStatus || 'pending',
    isVerified,
  };
}

async function publicProfileAsync(user) {
  if (!user) return null;
  const base = publicProfile(user);
  base.profileImageUrl = await effectiveProfileImageUrl(user);
  return base;
}

async function invitationPayload(inv) {
  const fromUser = await findUserById(inv.fromUserId);
  const toUser = await findUserById(inv.toUserId);
  const table = await Table.findOne({ id: inv.tableId }).lean();
  return {
    id: inv.id,
    fromUserId: inv.fromUserId,
    toUserId: inv.toUserId,
    tableId: inv.tableId,
    tableName: inv.tableName,
    tableImageKey: inv.tableImageKey || table?.tableImageKey || '',
    message: inv.message || '',
    prompts: inv.prompts || [],
    status: inv.status,
    createdAt: inv.createdAt,
    fromUser: await publicProfileAsync(fromUser),
    toUser: await publicProfileAsync(toUser),
    table,
  };
}

async function tablePayload(table, viewerId = null) {
  const host = await findUserById(table.hostUserId);
  const guest = await findUserById(table.guestUserId);
  const peer =
    viewerId != null && table.hostUserId === viewerId
      ? guest
      : viewerId != null && table.guestUserId === viewerId
        ? host
        : null;
  const tableMsgs = await Message.find({ tableId: table.id })
    .sort({ id: 1 })
    .lean();
  const last = tableMsgs.length ? tableMsgs[tableMsgs.length - 1] : null;
  const subject =
    viewerId != null ? await findUserById(viewerId) : host;
  const subjectVerified =
    String(subject?.verificationStatus || '').toLowerCase() === 'approved';
  return {
    id: table.id,
    name: table.name,
    tableImageKey: table.tableImageKey || '',
    hostUserId: table.hostUserId,
    guestUserId: table.guestUserId,
    invitationId: table.invitationId,
    status: table.status,
    createdAt: table.createdAt,
    host: await publicProfileAsync(host),
    guest: await publicProfileAsync(guest),
    peer: await publicProfileAsync(peer),
    messageCount: tableMsgs.length,
    trustLadder: trustLadderFromCount(tableMsgs.length, subjectVerified),
    lastMessage: last
      ? {
          id: last.id,
          text: last.text,
          senderId: last.senderId,
          createdAt: last.createdAt,
        }
      : null,
  };
}

async function messagePayload(msg) {
  const sender = await findUserById(msg.senderId);
  return {
    id: msg.id,
    tableId: msg.tableId,
    senderId: msg.senderId,
    text: msg.text,
    createdAt: msg.createdAt,
    sender: await publicProfileAsync(sender),
  };
}

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

function makeResetCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendPasswordResetEmail(toEmail, code) {
  if (!RESEND_API_KEY) {
    const err = new Error(
      'RESEND_API_KEY is not configured on the server',
    );
    err.code = 'NO_RESEND_KEY';
    throw err;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [toEmail],
      subject: 'Joshikai password reset code',
      html: `
        <div style="font-family: Georgia, serif; color: #3E2723; line-height: 1.5;">
          <h2 style="margin: 0 0 12px;">Reset your Joshikai password</h2>
          <p>Use this 6-digit code in the app to set a new password. It expires in 15 minutes.</p>
          <p style="font-size: 28px; letter-spacing: 6px; font-weight: 700;">${code}</p>
          <p style="color: #8C6860; font-size: 13px;">If you did not request this, you can ignore this email.</p>
        </div>
      `,
      text: `Your Joshikai password reset code is ${code}. It expires in 15 minutes.`,
    }),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.message || body?.error || JSON.stringify(body);
    } catch (_) {
      detail = await response.text();
    }
    const err = new Error(
      `Resend failed (${response.status})${detail ? `: ${detail}` : ''}`,
    );
    err.code = 'RESEND_FAILED';
    throw err;
  }
}

async function ensureDemoUsers() {
  const demos = [
    {
      email: 'yuki@joshikai.demo',
      name: 'Yuki',
      nickname: 'Yuki',
      age: 26,
      placeOfLiving: 'Shimokitazawa',
      lifeStatus: 'working',
      interests: ['Cafe Lover', 'Music', 'Photography', 'Travel', 'Bookworm'],
      bio: 'Looking for a calm Sunday coffee chat and language exchange.',
      profileImageUrl:
        'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&h=400&fit=crop',
    },
    {
      email: 'aiko@joshikai.demo',
      name: 'Aiko',
      nickname: 'Aiko',
      age: 24,
      placeOfLiving: 'Kichijoji',
      lifeStatus: 'student',
      interests: ['Anime', 'Manga', 'Arts', 'Cafe Lover', 'Exam Study Buddy'],
      bio: 'Art student who loves slow walks and cozy cafes.',
      profileImageUrl:
        'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&h=400&fit=crop',
    },
    {
      email: 'hana@joshikai.demo',
      name: 'Hana',
      nickname: 'Hana',
      age: 29,
      placeOfLiving: 'Shibuya',
      lifeStatus: 'working',
      interests: ['Fitness', 'Wine Tasting', 'Entrepreneurship', 'Travel', 'Music'],
      bio: 'Weekend explorer. Happy to practice EN ↔ JP over dinner.',
      profileImageUrl:
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&h=400&fit=crop',
    },
  ];

  const passwordHash = await bcrypt.hash('demo123', 10);
  for (const demo of demos) {
    const existing = await findUserByEmail(demo.email);
    if (existing) {
      if (!str(existing.profileImageUrl) && demo.profileImageUrl) {
        existing.profileImageUrl = demo.profileImageUrl;
        await existing.save();
      }
      continue;
    }
    await User.create({
      id: await getNextId('userId'),
      email: demo.email,
      passwordHash,
      name: demo.name,
      nickname: demo.nickname,
      profileImageUrl: demo.profileImageUrl || '',
      lifeStatus: demo.lifeStatus,
      age: demo.age,
      placeOfLiving: demo.placeOfLiving,
      phoneNumber: '',
      interests: demo.interests,
      bio: demo.bio,
      verificationStatus: 'approved',
      verificationId: null,
      passedUserIds: [],
      createdAt: new Date().toISOString(),
    });
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use('/admin', express.static(path.join(__dirname, 'admin-web')));

app.get('/health', async (_req, res) => {
  try {
    const [users, verifications] = await Promise.all([
      User.countDocuments(),
      Verification.countDocuments(),
    ]);
    res.json({
      ok: true,
      mongo: true,
      verifications,
      users,
      selfieMedia: true,
      build: 'mongo-v1',
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'Database unavailable' });
  }
});

// ——— User auth ———

app.post('/auth/register', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const profile = profileFromBody(body);
    if (!profile.email || !profile.password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    if (await findUserByEmail(profile.email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(profile.password, 10);
    const user = await User.create({
      id: await getNextId('userId'),
      email: profile.email,
      passwordHash,
      name: profile.name,
      nickname: profile.nickname,
      profileImageUrl: profile.profileImageUrl,
      lifeStatus: profile.lifeStatus,
      age: profile.age,
      placeOfLiving: profile.placeOfLiving,
      phoneNumber: profile.phoneNumber,
      interests: profile.interests,
      verificationStatus: 'pending',
      verificationId: null,
      passedUserIds: [],
      createdAt: new Date().toISOString(),
    });

    const token = newToken();
    userSessions.set(token, user.id);
    res.status(201).json({ token, user: await publicUser(user) });
  } catch (err) {
    console.error('register failed', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = str(body.email).toLowerCase();
    const password = String(body.password || '');
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = newToken();
    userSessions.set(token, user.id);
    res.json({ token, user: await publicUser(user) });
  } catch (err) {
    console.error('login failed', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/** Step 1: email a reset code (Resend). Does not change the password yet. */
app.post('/auth/forgot-password', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = str(body.email).toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const user = await findUserByEmail(email);
  if (!user) {
    return res.json({ ok: true, sent: true });
  }

  if (!RESEND_API_KEY) {
    return res.status(503).json({
      error:
        'Password reset email is not configured yet. Set RESEND_API_KEY on the server.',
    });
  }

  const code = makeResetCode();
  passwordResetCodes.set(email, {
    code,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });

  try {
    await sendPasswordResetEmail(email, code);
  } catch (e) {
    passwordResetCodes.delete(email);
    console.error('Password reset email failed:', e.message || e);
    return res.status(502).json({
      error:
        e.code === 'NO_RESEND_KEY'
          ? e.message
          : 'Could not send reset email. Please try again later.',
    });
  }

  res.json({ ok: true, sent: true });
});

/** Step 2: confirm email code + set new password, then user can re-login. */
app.post('/auth/reset-password', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = str(body.email).toLowerCase();
    const code = str(body.code);
    const newPassword = String(body.newPassword || body.password || '');

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        error: 'Email, code, and new password are required',
      });
    }
    if (newPassword.trim().length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters',
      });
    }

    const entry = passwordResetCodes.get(email);
    if (!entry || entry.code !== code || Date.now() > entry.expiresAt) {
      return res.status(400).json({
        error: 'Invalid or expired reset code',
      });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      passwordResetCodes.delete(email);
      return res.status(404).json({ error: 'Account not found' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.verificationStatus = 'pending';
    if (user.verificationId != null) {
      const linked = await Verification.findOne({ id: user.verificationId });
      if (linked) {
        linked.status = 'pending';
        linked.adminNote = str(linked.adminNote)
          ? `${linked.adminNote}\nPassword reset — re-approval required.`
          : 'Password reset — re-approval required.';
        await linked.save();
      }
    } else {
      const row = await Verification.create({
        id: await getNextId('verificationId'),
        userId: user.id,
        phoneNumber: user.phoneNumber || '',
        selfieUrl: '',
        status: 'pending',
        submittedAt: new Date().toISOString(),
        adminNote: 'Password reset — re-approval required.',
        email: user.email || '',
        name: user.name || '',
        nickname: user.nickname || '',
        profileImageUrl: user.profileImageUrl || '',
        lifeStatus: user.lifeStatus || '',
        age: user.age || 0,
        placeOfLiving: user.placeOfLiving || '',
        interests: user.interests || [],
      });
      user.verificationId = row.id;
    }
    await user.save();
    clearUserSessions(user.id);
    passwordResetCodes.delete(email);
    res.json({
      ok: true,
      verificationStatus: 'pending',
      requiresReapproval: true,
    });
  } catch (err) {
    console.error('reset-password failed', err);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

app.get('/auth/me', async (req, res) => {
  const user = await authUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ user: await publicUser(user) });
});

app.patch('/auth/me', async (req, res) => {
  try {
    const user = await authUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (Array.isArray(body.interests)) {
      user.interests = body.interests
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 5);
    }
    if (typeof body.similarAgeOn === 'boolean') user.similarAgeOn = body.similarAgeOn;
    if (typeof body.nearbyOn === 'boolean') user.nearbyOn = body.nearbyOn;
    if (typeof body.jpToEnOn === 'boolean') user.jpToEnOn = body.jpToEnOn;
    if (typeof body.enToJpOn === 'boolean') user.enToJpOn = body.enToJpOn;
    if (body.bio != null) user.bio = str(body.bio);
    await user.save();
    res.json({ user: await publicUser(user) });
  } catch (err) {
    console.error('patch /auth/me failed', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ——— Admin auth ———

app.post('/admin/auth/login', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = str(body.email).toLowerCase();
  const password = String(body.password || '').trim();
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (email !== ADMIN_EMAIL.toLowerCase() || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }
  const token = newToken();
  adminSessions.set(token, email);
  res.json({ token, email });
});

// ——— Admin user management ———

app.get('/admin/users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const q = str(req.query.q).toLowerCase();
    let rows = await User.find().sort({ id: -1 });
    let mapped = await Promise.all(rows.map((u) => publicUser(u)));
    if (q) {
      mapped = mapped.filter((u) => {
        const hay = [
          u.email,
          u.name,
          u.nickname,
          u.phoneNumber,
          u.placeOfLiving,
        ]
          .map((x) => String(x || '').toLowerCase())
          .join(' ');
        return hay.includes(q);
      });
    }
    res.json(mapped);
  } catch (err) {
    console.error('admin users list failed', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

app.get('/admin/users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number.parseInt(req.params.id, 10);
  const user = await findUserById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: await publicUser(user) });
});

app.patch('/admin/users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = Number.parseInt(req.params.id, 10);
    const user = await findUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.email != null) {
      const email = str(body.email).toLowerCase();
      if (!email) return res.status(400).json({ error: 'Email is required' });
      const clash = await findUserByEmail(email);
      if (clash && clash.id !== user.id) {
        return res.status(409).json({ error: 'Email already in use' });
      }
      user.email = email;
    }
    if (body.name != null) user.name = str(body.name);
    if (body.nickname != null) user.nickname = str(body.nickname);
    if (body.profileImageUrl != null) {
      user.profileImageUrl = normalizeImageUrl(body.profileImageUrl);
    }
    if (body.lifeStatus != null) user.lifeStatus = str(body.lifeStatus);
    if (body.age != null) {
      user.age = Number.parseInt(String(body.age), 10) || 0;
    }
    if (body.placeOfLiving != null) user.placeOfLiving = str(body.placeOfLiving);
    if (body.phoneNumber != null) user.phoneNumber = str(body.phoneNumber);
    if (body.bio != null) user.bio = str(body.bio);
    if (Array.isArray(body.interests)) {
      user.interests = body.interests
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 5);
    }
    if (body.verificationStatus != null) {
      const status = str(body.verificationStatus).toLowerCase();
      if (['pending', 'approved', 'rejected'].includes(status)) {
        user.verificationStatus = status;
      }
    }

    const email = String(user.email || '').toLowerCase();
    const linked = await Verification.findOne({ email }).sort({
      submittedAt: -1,
      id: -1,
    });
    if (linked) {
      linked.email = user.email;
      linked.name = user.name;
      linked.nickname = user.nickname;
      linked.profileImageUrl = user.profileImageUrl;
      linked.lifeStatus = user.lifeStatus;
      linked.age = user.age;
      linked.placeOfLiving = user.placeOfLiving;
      linked.phoneNumber = user.phoneNumber;
      linked.interests = user.interests || [];
      if (body.verificationStatus != null) {
        linked.status = user.verificationStatus;
      }
      if (String(user.verificationStatus || '').toLowerCase() === 'approved') {
        if (applyApprovedSelfieToProfile(user, linked.selfieUrl)) {
          linked.profileImageUrl = user.profileImageUrl;
        }
      }
      await linked.save();
    }

    await user.save();
    res.json({ user: await publicUser(user) });
  } catch (err) {
    console.error('admin patch user failed', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.post('/admin/users/:id/reset-password', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = Number.parseInt(req.params.id, 10);
    const user = await findUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let newPassword = String(body.password || '').trim();
    if (!newPassword) {
      newPassword = crypto.randomBytes(4).toString('hex');
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    clearUserSessions(user.id);
    res.json({
      ok: true,
      userId: user.id,
      email: user.email,
      temporaryPassword: newPassword,
    });
  } catch (err) {
    console.error('admin reset-password failed', err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

/** Serve the member's approved selfie as a real image (for Profile / Preference). */
app.get('/media/selfie/:userId', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.userId, 10);
    const user = await findUserById(id);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const linked = await latestVerificationForUser(user);
    let selfie = normalizeImageUrl(linked?.selfieUrl || '');
    if (!isUsableSelfieUrl(selfie)) {
      selfie = normalizeImageUrl(user.profileImageUrl);
    }
    if (selfie.startsWith('data:image') && selfie.includes(',')) {
      const comma = selfie.indexOf(',');
      const meta = selfie.slice(0, comma);
      const b64 = selfie.slice(comma + 1);
      const mimeMatch = /data:(image\/[a-zA-Z0-9.+-]+)/i.exec(meta);
      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      try {
        const buf = Buffer.from(b64, 'base64');
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.send(buf);
      } catch {
        return res.status(500).json({ error: 'Invalid selfie data' });
      }
    }
    if (/^https?:\/\//i.test(selfie) && !selfie.includes('/media/selfie/')) {
      return res.redirect(302, selfie);
    }
    return res.status(404).json({ error: 'No selfie on file' });
  } catch (err) {
    console.error('selfie media failed', err);
    res.status(500).json({ error: 'Failed to load selfie' });
  }
});

/** Image proxy so admin/app avatars still render when hosts block hotlinking. */
app.get('/media/image', async (req, res) => {
  const raw = typeof req.query.u === 'string' ? req.query.u : '';
  const target = normalizeImageUrl(raw);
  if (!/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: 'Invalid image URL' });
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Invalid image URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateHostname(parsed.hostname)) {
    return res.status(400).json({ error: 'URL not allowed' });
  }
  try {
    const upstream = await fetch(target, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; JoshikaiAvatarProxy/1.0; +https://joshikai.local)',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Upstream image fetch failed' });
    }
    let contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim();
    if (!contentType.toLowerCase().startsWith('image/')) {
      return res.status(415).json({ error: 'URL is not an image' });
    }
    let buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image too large' });
    }

    const lowerType = contentType.toLowerCase();
    const looksAvif =
      lowerType.includes('avif') ||
      lowerType.includes('heic') ||
      lowerType.includes('heif') ||
      /\.avif(\?|$)/i.test(parsed.pathname);
    if (looksAvif) {
      try {
        const sharp = require('sharp');
        buf = await sharp(buf).rotate().jpeg({ quality: 85 }).toBuffer();
        contentType = 'image/jpeg';
      } catch (convErr) {
        console.warn('Avatar convert failed:', convErr.message);
        return res.status(415).json({ error: 'Unsupported image format for app' });
      }
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: 'Could not load image' });
  }
});

app.delete('/admin/users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = Number.parseInt(req.params.id, 10);
    const removed = await User.findOneAndDelete({ id });
    if (!removed) return res.status(404).json({ error: 'User not found' });

    clearUserSessions(id);

    await Verification.deleteMany({ userId: id });
    await Invitation.deleteMany({
      $or: [{ fromUserId: id }, { toUserId: id }],
    });
    const removedTables = await Table.find({
      $or: [{ hostUserId: id }, { guestUserId: id }],
    }).lean();
    const removedTableIds = removedTables.map((t) => t.id);
    await Table.deleteMany({ id: { $in: removedTableIds } });
    await Message.deleteMany({ tableId: { $in: removedTableIds } });

    res.json({ ok: true, deletedUserId: removed.id, email: removed.email });
  } catch (err) {
    console.error('admin delete user failed', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ——— ID verifications ———

app.get('/id-verifications', async (req, res) => {
  try {
    const status =
      typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const limitRaw = req.query.limit;
    const limit =
      limitRaw === undefined || limitRaw === ''
        ? null
        : Number.parseInt(String(limitRaw), 10);

    const filter = status ? { status } : {};
    let query = Verification.find(filter).sort({ id: -1 });
    if (Number.isFinite(limit) && limit > 0) {
      query = query.limit(limit);
    }
    const rows = await query;
    res.json(await Promise.all(rows.map((row) => verificationWithUser(row))));
  } catch (err) {
    console.error('list verifications failed', err);
    res.status(500).json({ error: 'Failed to list verifications' });
  }
});

app.get('/id-verifications/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const row = await Verification.findOne({ id }).sort({
      submittedAt: -1,
      id: -1,
    });
    if (!row) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(await verificationWithUser(row));
  } catch (err) {
    console.error('get verification failed', err);
    res.status(500).json({ error: 'Failed to get verification' });
  }
});

app.post('/id-verifications', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const profile = profileFromBody(body);
    let user = await authUser(req);

    if (!user && profile.email && profile.password) {
      const existing = await findUserByEmail(profile.email);
      if (existing) {
        const ok = await bcrypt.compare(profile.password, existing.passwordHash);
        if (!ok) {
          return res.status(409).json({ error: 'Email already registered' });
        }
        user = existing;
      } else {
        user = await User.create({
          id: await getNextId('userId'),
          email: profile.email,
          passwordHash: await bcrypt.hash(profile.password, 10),
          name: profile.name,
          nickname: profile.nickname,
          profileImageUrl: profile.profileImageUrl,
          lifeStatus: profile.lifeStatus,
          age: profile.age,
          placeOfLiving: profile.placeOfLiving,
          phoneNumber: profile.phoneNumber,
          interests: profile.interests,
          verificationStatus: 'pending',
          verificationId: null,
          passedUserIds: [],
          createdAt: new Date().toISOString(),
        });
      }
    } else if (
      !user &&
      body.userId != null &&
      Number.isFinite(Number.parseInt(String(body.userId), 10))
    ) {
      user = await findUserById(Number.parseInt(String(body.userId), 10));
    }

    if (user) {
      if (profile.name) user.name = profile.name;
      if (profile.nickname) user.nickname = profile.nickname;
      if (profile.profileImageUrl) user.profileImageUrl = profile.profileImageUrl;
      if (profile.lifeStatus) user.lifeStatus = profile.lifeStatus;
      if (profile.age) user.age = profile.age;
      if (profile.placeOfLiving) user.placeOfLiving = profile.placeOfLiving;
      if (profile.phoneNumber) user.phoneNumber = profile.phoneNumber;
      if (profile.interests.length) user.interests = profile.interests;
    }

    const phoneNumber = profile.phoneNumber || user?.phoneNumber || '';
    const selfieUrl = str(body.selfieUrl);
    const status = str(body.status) || 'pending';
    const submittedAt = str(body.submittedAt) || new Date().toISOString();
    const adminNote = str(body.adminNote);

    if (!selfieUrl && !phoneNumber && !user) {
      return res.status(400).json({
        error: 'Submission requires profile fields and/or a selfie',
      });
    }

    const row = await Verification.create({
      id: await getNextId('verificationId'),
      userId: user?.id ?? null,
      phoneNumber,
      selfieUrl,
      status,
      submittedAt,
      adminNote,
      email: profile.email || user?.email || '',
      name: profile.name || user?.name || '',
      nickname: profile.nickname || user?.nickname || '',
      profileImageUrl: profile.profileImageUrl || user?.profileImageUrl || '',
      lifeStatus: profile.lifeStatus || user?.lifeStatus || '',
      age: profile.age || user?.age || 0,
      placeOfLiving: profile.placeOfLiving || user?.placeOfLiving || '',
      interests: profile.interests.length
        ? profile.interests
        : user?.interests || [],
    });

    if (user) {
      user.verificationId = row.id;
      user.verificationStatus = status;
      await user.save();
      const token = newToken();
      userSessions.set(token, user.id);
      return res.status(201).json({
        ...(await verificationWithUser(row)),
        token,
      });
    }

    res.status(201).json(await verificationWithUser(row));
  } catch (err) {
    console.error('create verification failed', err);
    res.status(500).json({ error: 'Submission failed' });
  }
});

app.patch('/id-verifications/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const current = await Verification.findOne({ id });
    if (!current) {
      return res.status(404).json({ error: 'Not found' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.status === 'string') current.status = body.status;
    if (typeof body.adminNote === 'string') current.adminNote = body.adminNote;

    const email = str(current.email);
    const u =
      (email && (await findUserByEmail(email))) ||
      (current.userId != null ? await findUserById(current.userId) : null);
    if (u) {
      u.verificationStatus = current.status;
      u.verificationId = current.id;
      current.userId = u.id;
      if (String(current.status || '').toLowerCase() === 'approved') {
        applyApprovedSelfieToProfile(u, current.selfieUrl);
        current.profileImageUrl = u.profileImageUrl;
      }
      await u.save();
    }

    await current.save();
    res.json(await verificationWithUser(current));
  } catch (err) {
    console.error('patch verification failed', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.get('/auth/status', async (req, res) => {
  const email = str(req.query.email).toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'email required' });
  }
  const user = await findUserByEmail(email);
  if (user) {
    return res.json({
      verificationStatus: user.verificationStatus || 'pending',
      userId: user.id,
      email: user.email,
    });
  }
  const row = await Verification.findOne({ email }).sort({ id: -1 }).lean();
  if (row) {
    return res.json({
      verificationStatus: row.status || 'pending',
      userId: row.userId || null,
      email,
    });
  }
  return res.json({ verificationStatus: 'pending', userId: null, email });
});

// ——— Matching / invitations / messaging ———

app.get('/room/profiles', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;

  try {
    const passed = new Set(me.passedUserIds || []);
    const similarAge = String(req.query.similarAge || '') === '1';
    const nearby = String(req.query.nearby || '') === '1';
    const interest = str(req.query.interest);

    const filter = {
      id: { $ne: me.id },
      verificationStatus: 'approved',
    };
    if (passed.size) {
      filter.id = { $ne: me.id, $nin: [...passed] };
    }

    let rows = await User.find(filter);
    if (similarAge && me.age) {
      rows = rows.filter((u) => Math.abs((u.age || 0) - me.age) <= 4);
    }
    if (nearby && me.placeOfLiving) {
      const place = String(me.placeOfLiving).toLowerCase();
      const token = place.split(/\s|,/)[0] || place;
      rows = rows.filter((u) =>
        String(u.placeOfLiving || '').toLowerCase().includes(token),
      );
    }
    if (interest) {
      rows = rows.filter((u) =>
        (u.interests || []).some(
          (x) => String(x).toLowerCase() === interest.toLowerCase(),
        ),
      );
    }

    res.json(await Promise.all(rows.map((u) => publicProfileAsync(u))));
  } catch (err) {
    console.error('room profiles failed', err);
    res.status(500).json({ error: 'Failed to load profiles' });
  }
});

app.get('/room/profiles/:id', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const user = await findUserById(id);
  if (!user || String(user.verificationStatus || '').toLowerCase() !== 'approved') {
    return res.status(404).json({ error: 'Profile not found' });
  }
  res.json(await publicProfileAsync(user));
});

app.post('/room/pass', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const targetId = Number.parseInt(String(body.userId || ''), 10);
  if (!Number.isFinite(targetId)) {
    return res.status(400).json({ error: 'userId required' });
  }
  if (!Array.isArray(me.passedUserIds)) me.passedUserIds = [];
  if (!me.passedUserIds.includes(targetId)) {
    me.passedUserIds.push(targetId);
    await me.save();
  }
  res.json({ ok: true });
});

app.post('/invitations', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const toUserId = Number.parseInt(String(body.toUserId || ''), 10);
    const tableName = str(body.tableName) || 'Table chat';
    const tableImageKey = str(body.tableImageKey) || 'drink';
    const message = str(body.message);
    const prompts = Array.isArray(body.prompts)
      ? body.prompts.map((x) => String(x)).filter(Boolean)
      : [];

    if (!Number.isFinite(toUserId)) {
      return res.status(400).json({ error: 'toUserId required' });
    }
    if (toUserId === me.id) {
      return res.status(400).json({ error: 'Cannot invite yourself' });
    }
    const toUser = await findUserById(toUserId);
    if (
      !toUser ||
      String(toUser.verificationStatus || '').toLowerCase() !== 'approved'
    ) {
      return res.status(404).json({ error: 'User not found' });
    }

    const existing = await Invitation.findOne({
      fromUserId: me.id,
      toUserId,
      status: 'pending',
    });
    if (existing) {
      return res.status(409).json({
        error: 'Invitation already pending',
        invitation: await invitationPayload(existing),
      });
    }

    const tableId = await getNextId('tableId');
    const invId = await getNextId('invitationId');
    const table = await Table.create({
      id: tableId,
      name: tableName,
      tableImageKey,
      hostUserId: me.id,
      guestUserId: toUserId,
      invitationId: invId,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    const inv = await Invitation.create({
      id: invId,
      fromUserId: me.id,
      toUserId,
      tableId: table.id,
      tableName,
      tableImageKey,
      message,
      prompts,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    res.status(201).json(await invitationPayload(inv));
  } catch (err) {
    console.error('create invitation failed', err);
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

app.get('/invitations', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  const box = str(req.query.box) || 'incoming';
  const status = str(req.query.status);

  const filter =
    box === 'outgoing' ? { fromUserId: me.id } : { toUserId: me.id };
  if (status) filter.status = status;

  const rows = await Invitation.find(filter).sort({ id: -1 });
  res.json(await Promise.all(rows.map((inv) => invitationPayload(inv))));
});

app.get('/invitations/:id', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const inv = await Invitation.findOne({ id });
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.fromUserId !== me.id && inv.toUserId !== me.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await invitationPayload(inv));
});

app.post('/invitations/:id/accept', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const id = Number.parseInt(req.params.id, 10);
    const inv = await Invitation.findOne({ id });
    if (!inv) return res.status(404).json({ error: 'Not found' });
    if (inv.toUserId !== me.id) {
      return res.status(403).json({ error: 'Only the invitee can accept' });
    }
    if (inv.status !== 'pending') {
      return res.status(409).json({ error: `Invitation is ${inv.status}` });
    }
    inv.status = 'accepted';
    await inv.save();

    const table = await Table.findOne({ id: inv.tableId });
    if (table) {
      table.status = 'active';
      await table.save();
    }

    const existingCount = await Message.countDocuments({ tableId: inv.tableId });
    if (existingCount === 0) {
      const prompt =
        Array.isArray(inv.prompts) && inv.prompts.length
          ? String(inv.prompts[0])
          : '';
      const opener =
        prompt ||
        inv.message ||
        `Hi! Looking forward to our table: ${inv.tableName}`;
      await Message.create({
        id: await getNextId('messageId'),
        tableId: inv.tableId,
        senderId: inv.fromUserId,
        text: opener,
        createdAt: new Date().toISOString(),
      });
    }

    res.json(await invitationPayload(inv));
  } catch (err) {
    console.error('accept invitation failed', err);
    res.status(500).json({ error: 'Accept failed' });
  }
});

app.post('/invitations/:id/decline', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const id = Number.parseInt(req.params.id, 10);
    const inv = await Invitation.findOne({ id });
    if (!inv) return res.status(404).json({ error: 'Not found' });
    if (inv.toUserId !== me.id) {
      return res.status(403).json({ error: 'Only the invitee can decline' });
    }
    if (inv.status !== 'pending') {
      return res.status(409).json({ error: `Invitation is ${inv.status}` });
    }
    inv.status = 'declined';
    await inv.save();
    const table = await Table.findOne({ id: inv.tableId });
    if (table) {
      table.status = 'declined';
      await table.save();
    }
    res.json(await invitationPayload(inv));
  } catch (err) {
    console.error('decline invitation failed', err);
    res.status(500).json({ error: 'Decline failed' });
  }
});

app.get('/tables/:id', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const table = await Table.findOne({ id }).lean();
  if (!table) return res.status(404).json({ error: 'Not found' });
  if (table.hostUserId !== me.id && table.guestUserId !== me.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await tablePayload(table));
});

app.get('/tables/:id/messages', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const table = await Table.findOne({ id }).lean();
  if (!table) return res.status(404).json({ error: 'Not found' });
  if (table.hostUserId !== me.id && table.guestUserId !== me.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const rows = await Message.find({ tableId: id }).sort({ id: 1 });
  res.json(await Promise.all(rows.map((m) => messagePayload(m))));
});

app.post('/tables/:id/messages', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const id = Number.parseInt(req.params.id, 10);
    const table = await Table.findOne({ id });
    if (!table) return res.status(404).json({ error: 'Not found' });
    if (table.hostUserId !== me.id && table.guestUserId !== me.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (table.status !== 'active') {
      return res.status(409).json({
        error: 'Waiting for invitee to accept before messaging',
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const text = str(body.text);
    if (!text) return res.status(400).json({ error: 'text required' });

    const msg = await Message.create({
      id: await getNextId('messageId'),
      tableId: id,
      senderId: me.id,
      text,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(await messagePayload(msg));
  } catch (err) {
    console.error('post message failed', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.get('/tables', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const statusRaw = str(req.query.status).toLowerCase();
    const includeAll = ['all', 'any', 'history'].includes(statusRaw);
    const statusFilter = includeAll ? null : statusRaw || 'active';
    const filter = {
      $or: [{ hostUserId: me.id }, { guestUserId: me.id }],
    };
    if (statusFilter != null) filter.status = statusFilter;

    const rows = await Table.find(filter).lean();
    const withLast = await Promise.all(
      rows.map(async (t) => {
        const last = await Message.findOne({ tableId: t.id })
          .sort({ id: -1 })
          .select('id')
          .lean();
        return { table: t, lastId: last?.id || 0 };
      }),
    );
    withLast.sort((a, b) => {
      if (b.lastId !== a.lastId) return b.lastId - a.lastId;
      return b.table.id - a.table.id;
    });
    res.json(
      await Promise.all(withLast.map(({ table }) => tablePayload(table, me.id))),
    );
  } catch (err) {
    console.error('list tables failed', err);
    res.status(500).json({ error: 'Failed to list tables' });
  }
});

app.get('/chats', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const rows = await Table.find({
      $or: [{ hostUserId: me.id }, { guestUserId: me.id }],
    }).lean();
    const withLast = await Promise.all(
      rows.map(async (t) => {
        const last = await Message.findOne({ tableId: t.id })
          .sort({ id: -1 })
          .select('id')
          .lean();
        return { table: t, lastId: last?.id || 0 };
      }),
    );
    withLast.sort((a, b) => {
      if (b.lastId !== a.lastId) return b.lastId - a.lastId;
      return b.table.id - a.table.id;
    });
    res.json(
      await Promise.all(withLast.map(({ table }) => tablePayload(table, me.id))),
    );
  } catch (err) {
    console.error('list chats failed', err);
    res.status(500).json({ error: 'Failed to list chats' });
  }
});

async function start() {
  try {
    await connectMongo(MONGODB_URI);
    await migrateFromJsonIfEmpty();
    await syncCountersFromData();
    const selfieBackfill = await backfillApprovedSelfies();
    if (selfieBackfill) {
      console.log(
        `Backfilled approved selfie → profileImageUrl for ${selfieBackfill} members`,
      );
    }
    await ensureDemoUsers();

    app.listen(PORT, HOST, () => {
      console.log(`Joshikai API listening on http://${HOST}:${PORT}`);
      console.log(`Admin web: http://${HOST}:${PORT}/admin/`);
      console.log(`MongoDB: ${MONGODB_URI.replace(/\/\/.*@/, '//***@')}`);
      console.log(`Admin login: ${ADMIN_EMAIL} / (see ADMIN_PASSWORD env)`);
    });
  } catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
  }
}

start();
