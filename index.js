const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const PORT = Number(process.env.PORT) || 4100;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@joshikai.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = path.join(__dirname, 'data.json');

/** @type {Map<string, number>} */
const userSessions = new Map();
/** @type {Map<string, string>} admin token -> email */
const adminSessions = new Map();

/** @type {Array<object>} */
let users = [];
let nextUserId = 1;

/** Live submissions only — no seed/temp rows. */
/** @type {Array<object>} */
let verifications = [];
let nextVerificationId = 1;

/** @type {Array<object>} */
let invitations = [];
let nextInvitationId = 1;
/** @type {Array<object>} */
let tables = [];
let nextTableId = 1;
/** @type {Array<object>} */
let messages = [];
let nextMessageId = 1;
/** userId -> Set of passed profile userIds */
const passedByUser = new Map();

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    users = Array.isArray(raw.users) ? raw.users : [];
    verifications = Array.isArray(raw.verifications) ? raw.verifications : [];
    invitations = Array.isArray(raw.invitations) ? raw.invitations : [];
    tables = Array.isArray(raw.tables) ? raw.tables : [];
    messages = Array.isArray(raw.messages) ? raw.messages : [];

    // Repair duplicate user IDs (auth + admin join use find-by-id).
    let maxUserId = users.reduce(
      (m, u) => Math.max(m, Number(u.id) || 0),
      0,
    );
    const seenUserIds = new Set();
    const userIdRemaps = [];
    for (const u of users) {
      const id = Number(u.id) || 0;
      if (!id || seenUserIds.has(id)) {
        const oldId = id;
        maxUserId += 1;
        u.id = maxUserId;
        userIdRemaps.push({ user: u, oldId, newId: maxUserId });
      }
      seenUserIds.add(u.id);
    }
    for (const { user, newId } of userIdRemaps) {
      const email = String(user.email || '').toLowerCase();
      if (!email) continue;
      for (const v of verifications) {
        if (String(v.email || '').toLowerCase() === email) {
          v.userId = newId;
        }
      }
    }

    // Repair duplicate verification IDs (admin detail uses find-by-id).
    let maxVerId = verifications.reduce(
      (m, v) => Math.max(m, Number(v.id) || 0),
      0,
    );
    const seenVerIds = new Set();
    for (const row of verifications) {
      const id = Number(row.id) || 0;
      if (!id || seenVerIds.has(id)) {
        maxVerId += 1;
        row.id = maxVerId;
      }
      seenVerIds.add(row.id);
    }

    // Link verificationId by email only (never by colliding userId).
    for (const u of users) {
      const email = String(u.email || '').toLowerCase();
      const byEmail = email
        ? verifications.filter(
            (v) => String(v.email || '').toLowerCase() === email,
          )
        : [];
      if (byEmail.length) {
        u.verificationId = byEmail.sort((a, b) => b.id - a.id)[0].id;
        continue;
      }
      if (
        u.verificationId != null &&
        !verifications.some(
          (v) =>
            v.id === u.verificationId &&
            v.userId === u.id &&
            !String(v.email || '').trim(),
        )
      ) {
        u.verificationId = null;
      }
    }

    nextUserId = Math.max(
      Number(raw.nextUserId) || 1,
      users.reduce((m, u) => Math.max(m, u.id || 0), 0) + 1,
      maxUserId + 1,
    );
    nextVerificationId = Math.max(
      Number(raw.nextVerificationId) || 1,
      verifications.reduce((m, v) => Math.max(m, v.id || 0), 0) + 1,
      maxVerId + 1,
    );
    nextInvitationId = Math.max(
      Number(raw.nextInvitationId) || 1,
      invitations.reduce((m, i) => Math.max(m, i.id || 0), 0) + 1,
    );
    nextTableId = Math.max(
      Number(raw.nextTableId) || 1,
      tables.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1,
    );
    nextMessageId = Math.max(
      Number(raw.nextMessageId) || 1,
      messages.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1,
    );
    console.log(
      `Loaded ${users.length} users, ${verifications.length} verifications, ${invitations.length} invitations from data.json (nextVerificationId=${nextVerificationId})`,
    );
    saveData();
  } catch (err) {
    console.error('Failed to load data.json', err);
  }
}

function saveData() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          users,
          verifications,
          invitations,
          tables,
          messages,
          nextUserId,
          nextVerificationId,
          nextInvitationId,
          nextTableId,
          nextMessageId,
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error('Failed to save data.json', err);
  }
}

loadData();

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function messageCountForTable(tableId) {
  return messages.filter((m) => m.tableId === tableId).length;
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
  // Medium → Verified badge only when selfie-verified; Rich → Gold.
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

/** Best (highest message count) match ladder for a user — for Profile Expanded. */
function bestTrustLadderForUser(user) {
  if (!user) {
    return trustLadderFromCount(0, false);
  }
  const isVerified =
    String(user.verificationStatus || '').toLowerCase() === 'approved';
  const myTables = tables.filter(
    (t) => t.hostUserId === user.id || t.guestUserId === user.id,
  );
  let bestCount = 0;
  let bestTable = null;
  for (const t of myTables) {
    const c = messageCountForTable(t.id);
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
    const peer = findUserById(peerId);
    ladder.peerName = peer?.nickname || peer?.name || '';
  } else {
    ladder.tableId = null;
    ladder.tableName = '';
    ladder.peerName = '';
  }
  return ladder;
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  const isVerified =
    String(user.verificationStatus || '').toLowerCase() === 'approved';
  return {
    ...rest,
    isVerified,
    trustLadder: bestTrustLadderForUser(user),
  };
}

function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return users.find((u) => u.email === normalized);
}

function authUser(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const userId = userSessions.get(match[1]);
  if (!userId) return null;
  return findUserById(userId);
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
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

function verificationPayload(row, user) {
  return {
    id: row.id,
    userId: row.userId,
    phoneNumber: row.phoneNumber || user?.phoneNumber || '',
    selfieUrl: row.selfieUrl || '',
    status: row.status,
    submittedAt: row.submittedAt,
    adminNote: row.adminNote || '',
    email: row.email || user?.email || '',
    name: row.name || user?.name || '',
    nickname: row.nickname || user?.nickname || '',
    profileImageUrl: row.profileImageUrl || user?.profileImageUrl || '',
    lifeStatus: row.lifeStatus || user?.lifeStatus || '',
    age: row.age ?? user?.age ?? 0,
    placeOfLiving: row.placeOfLiving || user?.placeOfLiving || '',
    interests: row.interests || user?.interests || [],
    user: user ? publicUser(user) : null,
  };
}

function findUserById(id) {
  if (id == null) return null;
  const matches = users.filter((u) => u.id === id);
  if (matches.length <= 1) return matches[0] || null;
  // Prefer the newest account if legacy duplicate IDs still exist.
  return matches.sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  )[0];
}

function verificationWithUser(row) {
  let user = row.email ? findUserByEmail(row.email) : null;
  if (!user && row.userId != null) {
    user = findUserById(row.userId);
  }
  return verificationPayload(row, user);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use('/admin', express.static(path.join(__dirname, 'admin-web')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, verifications: verifications.length, users: users.length });
});

// ——— User auth ———

app.post('/auth/register', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const profile = profileFromBody(body);
  if (!profile.email || !profile.password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  if (findUserByEmail(profile.email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const passwordHash = await bcrypt.hash(profile.password, 10);
  const user = {
    id: nextUserId++,
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
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveData();

  const token = newToken();
  userSessions.set(token, user.id);

  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/auth/login', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = str(body.email).toLowerCase();
  const password = String(body.password || '');
  const user = findUserByEmail(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = newToken();
  userSessions.set(token, user.id);
  res.json({ token, user: publicUser(user) });
});

app.get('/auth/me', (req, res) => {
  const user = authUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ user: publicUser(user) });
});

app.patch('/auth/me', (req, res) => {
  const user = authUser(req);
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
  saveData();
  res.json({ user: publicUser(user) });
});

app.patch('/auth/me', (req, res) => {
  const user = authUser(req);
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
  saveData();
  res.json({ user: publicUser(user) });
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

function requireAdmin(req, res) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !adminSessions.has(match[1])) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return match[1];
}

function clearUserSessions(userId) {
  for (const [tok, uid] of userSessions.entries()) {
    if (uid === userId) userSessions.delete(tok);
  }
}

// ——— Admin user management ———

app.get('/admin/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = str(req.query.q).toLowerCase();
  let rows = users.map((u) => publicUser(u));
  if (q) {
    rows = rows.filter((u) => {
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
  rows.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
  res.json(rows);
});

app.get('/admin/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number.parseInt(req.params.id, 10);
  const user = findUserById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

app.patch('/admin/users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number.parseInt(req.params.id, 10);
  const user = findUserById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.email != null) {
    const email = str(body.email).toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const clash = findUserByEmail(email);
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

  // Keep latest verification row in sync for admin queue display.
  const email = String(user.email || '').toLowerCase();
  const linked = verifications
    .filter((v) => String(v.email || '').toLowerCase() === email)
    .sort((a, b) =>
      String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')),
    )[0];
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
  }

  saveData();
  res.json({ user: publicUser(user) });
});

app.post('/admin/users/:id/reset-password', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number.parseInt(req.params.id, 10);
  const user = findUserById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let newPassword = String(body.password || '').trim();
  if (!newPassword) {
    newPassword = crypto.randomBytes(4).toString('hex'); // 8 chars
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  clearUserSessions(user.id);
  saveData();
  res.json({
    ok: true,
    userId: user.id,
    email: user.email,
    temporaryPassword: newPassword,
  });
});

/** Image proxy so admin/app avatars still render when hosts block hotlinking.
 *  Flutter cannot decode AVIF/HEIC, so those are converted to JPEG via sharp.
 */
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

app.delete('/admin/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number.parseInt(req.params.id, 10);
  const index = users.findIndex((u) => u.id === id);
  if (index === -1) return res.status(404).json({ error: 'User not found' });

  const [removed] = users.splice(index, 1);
  clearUserSessions(id);
  passedByUser.delete(id);

  // Soft-clean related rows so admin queue stays consistent.
  verifications = verifications.filter((v) => v.userId !== id);
  invitations = invitations.filter(
    (inv) => inv.fromUserId !== id && inv.toUserId !== id,
  );
  const removedTableIds = new Set(
    tables.filter((t) => t.hostUserId === id || t.guestUserId === id).map((t) => t.id),
  );
  tables = tables.filter((t) => !removedTableIds.has(t.id));
  messages = messages.filter((m) => !removedTableIds.has(m.tableId));

  saveData();
  res.json({ ok: true, deletedUserId: removed.id, email: removed.email });
});

// ——— ID verifications ———

app.get('/id-verifications', (req, res) => {
  const status =
    typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const limitRaw = req.query.limit;
  const limit =
    limitRaw === undefined || limitRaw === ''
      ? null
      : Number.parseInt(String(limitRaw), 10);

  let rows = [...verifications];
  if (status) {
    rows = rows.filter((row) => row.status === status);
  }
  rows.sort((a, b) => b.id - a.id);
  if (Number.isFinite(limit) && limit > 0) {
    rows = rows.slice(0, limit);
  }
  res.json(rows.map(verificationWithUser));
});

app.get('/id-verifications/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  // Prefer exact unique match; if legacy duplicates existed, take the newest.
  const matches = verifications.filter((v) => v.id === id);
  const row = matches.sort((a, b) =>
    String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')),
  )[0];
  if (!row) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(verificationWithUser(row));
});

app.post('/id-verifications', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const profile = profileFromBody(body);
  let user = authUser(req);

  // App submit path: create (or update) user from registration fields.
  if (!user && profile.email && profile.password) {
    const existing = findUserByEmail(profile.email);
    if (existing) {
      const ok = await bcrypt.compare(profile.password, existing.passwordHash);
      if (!ok) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      user = existing;
    } else {
      const passwordHash = await bcrypt.hash(profile.password, 10);
      user = {
        id: nextUserId++,
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
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      saveData();
    }
  } else if (
    !user &&
    body.userId != null &&
    Number.isFinite(Number.parseInt(String(body.userId), 10))
  ) {
    user =
      users.find((u) => u.id === Number.parseInt(String(body.userId), 10)) ||
      null;
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
  const status =
    str(body.status) || 'pending';
  const submittedAt = str(body.submittedAt) || new Date().toISOString();
  const adminNote = str(body.adminNote);

  if (!selfieUrl && !phoneNumber && !user) {
    return res.status(400).json({
      error: 'Submission requires profile fields and/or a selfie',
    });
  }

  const row = {
    id: nextVerificationId++,
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
  };
  verifications.push(row);

  if (user) {
    user.verificationId = row.id;
    user.verificationStatus = status;
    saveData();
    const token = newToken();
    userSessions.set(token, user.id);
    return res.status(201).json({
      ...verificationWithUser(row),
      token,
    });
  }

  saveData();
  res.status(201).json(verificationWithUser(row));
});

app.patch('/id-verifications/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const index = verifications.findIndex((v) => v.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Not found' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const current = verifications[index];
  const updated = {
    ...current,
    status: typeof body.status === 'string' ? body.status : current.status,
    adminNote:
      typeof body.adminNote === 'string' ? body.adminNote : current.adminNote,
  };
  verifications[index] = updated;

  // Prefer email so approval never updates a colliding demo userId.
  const email = str(updated.email);
  const u =
    (email && findUserByEmail(email)) ||
    (updated.userId != null ? findUserById(updated.userId) : null);
  if (u) {
    u.verificationStatus = updated.status;
    u.verificationId = updated.id;
    updated.userId = u.id;
    verifications[index] = updated;
  }

  saveData();
  res.json(verificationWithUser(updated));
});

// Public status lookup so the app can refresh after admin approval.
app.get('/auth/status', (req, res) => {
  const email = str(req.query.email).toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'email required' });
  }
  const user = findUserByEmail(email);
  if (user) {
    return res.json({
      verificationStatus: user.verificationStatus || 'pending',
      userId: user.id,
      email: user.email,
    });
  }
  const rows = verifications
    .filter((v) => str(v.email).toLowerCase() === email)
    .sort((a, b) => b.id - a.id);
  if (rows.length) {
    return res.json({
      verificationStatus: rows[0].status || 'pending',
      userId: rows[0].userId || null,
      email,
    });
  }
  return res.json({ verificationStatus: 'pending', userId: null, email });
});


// ——— Matching / invitations / messaging ———

function publicProfile(user) {
  if (!user) return null;
  const isVerified =
    String(user.verificationStatus || '').toLowerCase() === 'approved';
  return {
    id: user.id,
    email: user.email,
    name: user.name || user.nickname || '',
    nickname: user.nickname || user.name || '',
    profileImageUrl: user.profileImageUrl || '',
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

function requireApprovedUser(req, res) {
  const user = authUser(req);
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

function invitationPayload(inv) {
  const fromUser = findUserById(inv.fromUserId);
  const toUser = findUserById(inv.toUserId);
  const table = tables.find((t) => t.id === inv.tableId) || null;
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
    fromUser: publicProfile(fromUser),
    toUser: publicProfile(toUser),
    table,
  };
}

function tablePayload(table, viewerId = null) {
  const host = findUserById(table.hostUserId);
  const guest = findUserById(table.guestUserId);
  const peer =
    viewerId != null && table.hostUserId === viewerId
      ? guest
      : viewerId != null && table.guestUserId === viewerId
        ? host
        : null;
  const tableMsgs = messages
    .filter((m) => m.tableId === table.id)
    .sort((a, b) => a.id - b.id);
  const last = tableMsgs.length ? tableMsgs[tableMsgs.length - 1] : null;
  const subject =
    viewerId != null ? findUserById(viewerId) : host;
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
    host: publicProfile(host),
    guest: publicProfile(guest),
    peer: publicProfile(peer),
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

function messagePayload(msg) {
  const sender = users.find((u) => u.id === msg.senderId) || null;
  return {
    id: msg.id,
    tableId: msg.tableId,
    senderId: msg.senderId,
    text: msg.text,
    createdAt: msg.createdAt,
    sender: publicProfile(sender),
  };
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
    const existing = findUserByEmail(demo.email);
    if (existing) {
      if (!str(existing.profileImageUrl) && demo.profileImageUrl) {
        existing.profileImageUrl = demo.profileImageUrl;
      }
      continue;
    }
    users.push({
      id: nextUserId++,
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
      createdAt: new Date().toISOString(),
    });
  }
}

ensureDemoUsers()
  .then(() => saveData())
  .catch((err) => {
  console.error('Failed to seed demo users', err);
});

app.get('/room/profiles', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;

  const passed = passedByUser.get(me.id) || new Set();
  const similarAge = String(req.query.similarAge || '') === '1';
  const nearby = String(req.query.nearby || '') === '1';
  const interest = str(req.query.interest);

  let rows = users.filter(
    (u) =>
      u.id !== me.id &&
      String(u.verificationStatus || '').toLowerCase() === 'approved' &&
      !passed.has(u.id),
  );

  if (similarAge && me.age) {
    rows = rows.filter((u) => Math.abs((u.age || 0) - me.age) <= 4);
  }
  if (nearby && me.placeOfLiving) {
    const place = String(me.placeOfLiving).toLowerCase();
    rows = rows.filter((u) =>
      String(u.placeOfLiving || '')
        .toLowerCase()
        .includes(place.split(/\s|,/)[0] || place),
    );
  }
  if (interest) {
    rows = rows.filter((u) =>
      (u.interests || []).some(
        (x) => String(x).toLowerCase() === interest.toLowerCase(),
      ),
    );
  }

  res.json(rows.map(publicProfile));
});

app.get('/room/profiles/:id', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const user = users.find((u) => u.id === id);
  if (!user || String(user.verificationStatus || '').toLowerCase() !== 'approved') {
    return res.status(404).json({ error: 'Profile not found' });
  }
  res.json(publicProfile(user));
});

app.post('/room/pass', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const targetId = Number.parseInt(String(body.userId || ''), 10);
  if (!Number.isFinite(targetId)) {
    return res.status(400).json({ error: 'userId required' });
  }
  if (!passedByUser.has(me.id)) passedByUser.set(me.id, new Set());
  passedByUser.get(me.id).add(targetId);
  saveData();
  res.json({ ok: true });
});

app.post('/invitations', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
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
  const toUser = users.find((u) => u.id === toUserId);
  if (!toUser || String(toUser.verificationStatus || '').toLowerCase() !== 'approved') {
    return res.status(404).json({ error: 'User not found' });
  }

  const existing = invitations.find(
    (i) =>
      i.fromUserId === me.id &&
      i.toUserId === toUserId &&
      i.status === 'pending',
  );
  if (existing) {
    return res.status(409).json({ error: 'Invitation already pending', invitation: invitationPayload(existing) });
  }

  const table = {
    id: nextTableId++,
    name: tableName,
    tableImageKey,
    hostUserId: me.id,
    guestUserId: toUserId,
    invitationId: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  tables.push(table);

  const inv = {
    id: nextInvitationId++,
    fromUserId: me.id,
    toUserId,
    tableId: table.id,
    tableName,
    tableImageKey,
    message,
    prompts,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  table.invitationId = inv.id;
  invitations.push(inv);
  saveData();

  res.status(201).json(invitationPayload(inv));
});

app.get('/invitations', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const box = str(req.query.box) || 'incoming';
  const status = str(req.query.status);

  let rows = invitations.filter((i) =>
    box === 'outgoing' ? i.fromUserId === me.id : i.toUserId === me.id,
  );
  if (status) {
    rows = rows.filter((i) => i.status === status);
  }
  rows.sort((a, b) => b.id - a.id);
  res.json(rows.map(invitationPayload));
});

app.get('/invitations/:id', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const inv = invitations.find((i) => i.id === id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.fromUserId !== me.id && inv.toUserId !== me.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(invitationPayload(inv));
});

app.post('/invitations/:id/accept', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const inv = invitations.find((i) => i.id === id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.toUserId !== me.id) {
    return res.status(403).json({ error: 'Only the invitee can accept' });
  }
  if (inv.status !== 'pending') {
    return res.status(409).json({ error: `Invitation is ${inv.status}` });
  }
  inv.status = 'accepted';
  const table = tables.find((t) => t.id === inv.tableId);
  if (table) table.status = 'active';

  // Seed opener: prefer selected opening prompt, then custom message.
  const existingMsgs = messages.filter((m) => m.tableId === inv.tableId);
  if (existingMsgs.length === 0) {
    const prompt =
      Array.isArray(inv.prompts) && inv.prompts.length
        ? String(inv.prompts[0])
        : '';
    const opener =
      prompt ||
      inv.message ||
      `Hi! Looking forward to our table: ${inv.tableName}`;
    messages.push({
      id: nextMessageId++,
      tableId: inv.tableId,
      senderId: inv.fromUserId,
      text: opener,
      createdAt: new Date().toISOString(),
    });
  }

  saveData();
  res.json(invitationPayload(inv));
});

app.post('/invitations/:id/decline', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const inv = invitations.find((i) => i.id === id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.toUserId !== me.id) {
    return res.status(403).json({ error: 'Only the invitee can decline' });
  }
  if (inv.status !== 'pending') {
    return res.status(409).json({ error: `Invitation is ${inv.status}` });
  }
  inv.status = 'declined';
  const table = tables.find((t) => t.id === inv.tableId);
  if (table) table.status = 'declined';
  saveData();
  res.json(invitationPayload(inv));
});

app.get('/tables/:id', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const table = tables.find((t) => t.id === id);
  if (!table) return res.status(404).json({ error: 'Not found' });
  if (table.hostUserId !== me.id && table.guestUserId !== me.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(tablePayload(table));
});

app.get('/tables/:id/messages', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const table = tables.find((t) => t.id === id);
  if (!table) return res.status(404).json({ error: 'Not found' });
  if (table.hostUserId !== me.id && table.guestUserId !== me.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const rows = messages
    .filter((m) => m.tableId === id)
    .sort((a, b) => a.id - b.id);
  res.json(rows.map(messagePayload));
});

app.post('/tables/:id/messages', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const table = tables.find((t) => t.id === id);
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

  const msg = {
    id: nextMessageId++,
    tableId: id,
    senderId: me.id,
    text,
    createdAt: new Date().toISOString(),
  };
  messages.push(msg);
  saveData();
  res.status(201).json(messagePayload(msg));
});

app.get('/tables', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const statusRaw = str(req.query.status).toLowerCase();
  // Default active; pass status=all|any|history for full chat history.
  const includeAll = ['all', 'any', 'history'].includes(statusRaw);
  const statusFilter = includeAll ? null : statusRaw || 'active';
  const rows = tables
    .filter(
      (t) =>
        (t.hostUserId === me.id || t.guestUserId === me.id) &&
        (statusFilter == null || t.status === statusFilter),
    )
    .sort((a, b) => {
      const aLast = messages
        .filter((m) => m.tableId === a.id)
        .reduce((max, m) => Math.max(max, m.id || 0), 0);
      const bLast = messages
        .filter((m) => m.tableId === b.id)
        .reduce((max, m) => Math.max(max, m.id || 0), 0);
      if (bLast !== aLast) return bLast - aLast;
      return b.id - a.id;
    });
  res.json(rows.map((t) => tablePayload(t, me.id)));
});

/** Dedicated chat history list (active + waiting + past tables). */
app.get('/chats', (req, res) => {
  const me = requireApprovedUser(req, res);
  if (!me) return;
  const rows = tables
    .filter((t) => t.hostUserId === me.id || t.guestUserId === me.id)
    .sort((a, b) => {
      const aLast = messages
        .filter((m) => m.tableId === a.id)
        .reduce((max, m) => Math.max(max, m.id || 0), 0);
      const bLast = messages
        .filter((m) => m.tableId === b.id)
        .reduce((max, m) => Math.max(max, m.id || 0), 0);
      if (bLast !== aLast) return bLast - aLast;
      return b.id - a.id;
    });
  res.json(rows.map((t) => tablePayload(t, me.id)));
});

app.listen(PORT, HOST, () => {
  console.log(`Joshikai API listening on http://${HOST}:${PORT}`);
  console.log(`Admin web: http://${HOST}:${PORT}/admin/`);
  console.log(`Admin login: ${ADMIN_EMAIL} / (see ADMIN_PASSWORD env)`);
});
