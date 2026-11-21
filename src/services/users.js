const bcrypt = require('bcryptjs');
const {
  User,
  Invitation,
  Table,
  Message,
} = require('../models');
const { getNextId, stripMongoId } = require('../db');
const { str } = require('../lib/util');
const { userSessions } = require('../lib/tokens');
const {
  normalizeImageUrl,
  effectiveProfileImageUrl,
  latestVerificationForUser,
  selfieMediaUrl,
  hasApprovedSelfie,
} = require('../lib/images');

async function findUserById(id) {
  if (id == null || !Number.isFinite(Number(id))) return null;
  return User.findOne({ id: Number(id) });
}

async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return User.findOne({ email: normalized });
}

async function messageCountForTable(tableId) {
  return Message.countDocuments({ tableId });
}

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
  const { passwordHash, passedUserIds, blockedUserIds, ...rest } = plain;
  const isVerified =
    String(user.verificationStatus || '').toLowerCase() === 'approved';
  return {
    ...rest,
    profileImageUrl: await effectiveProfileImageUrl(user),
    isVerified,
    trustLadder: await bestTrustLadderForUser(user),
  };
}

function blockedSetFor(user) {
  return new Set(
    (Array.isArray(user?.blockedUserIds) ? user.blockedUserIds : [])
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n)),
  );
}

function isEitherBlocked(a, b) {
  if (!a || !b) return false;
  const aId = Number(a.id);
  const bId = Number(b.id);
  if (!Number.isFinite(aId) || !Number.isFinite(bId)) return false;
  return blockedSetFor(a).has(bId) || blockedSetFor(b).has(aId);
}

async function declinePendingInvitesBetween(userAId, userBId) {
  const pending = await Invitation.find({
    status: 'pending',
    $or: [
      { fromUserId: userAId, toUserId: userBId },
      { fromUserId: userBId, toUserId: userAId },
    ],
  });
  for (const inv of pending) {
    inv.status = 'declined';
    await inv.save();
    if (inv.tableId != null) {
      const table = await Table.findOne({ id: inv.tableId });
      if (table && table.status === 'pending') {
        table.status = 'declined';
        await table.save();
      }
    }
  }
  return pending.length;
}

async function authUser(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const userId = userSessions.get(match[1]);
  if (!userId) return null;
  return findUserById(userId);
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
    jpToEnOn: user.jpToEnOn === true,
    enToJpOn: user.enToJpOn === true,
  };
}

async function publicProfileAsync(user) {
  if (!user) return null;
  const base = publicProfile(user);
  base.profileImageUrl = await effectiveProfileImageUrl(user);
  base.trustLadder = await bestTrustLadderForUser(user);
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
      jpToEnOn: true,
      enToJpOn: false,
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
      jpToEnOn: true,
      enToJpOn: true,
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
      jpToEnOn: false,
      enToJpOn: true,
      profileImageUrl:
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&h=400&fit=crop',
    },
  ];

  const passwordHash = await bcrypt.hash('demo123', 10);
  for (const demo of demos) {
    const existing = await findUserByEmail(demo.email);
    if (existing) {
      let changed = false;
      if (!str(existing.profileImageUrl) && demo.profileImageUrl) {
        existing.profileImageUrl = demo.profileImageUrl;
        changed = true;
      }
      if (existing.jpToEnOn !== true && existing.enToJpOn !== true) {
        existing.jpToEnOn = demo.jpToEnOn === true;
        existing.enToJpOn = demo.enToJpOn === true;
        changed = true;
      }
      if (changed) await existing.save();
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
      jpToEnOn: demo.jpToEnOn === true,
      enToJpOn: demo.enToJpOn === true,
      verificationStatus: 'approved',
      verificationId: null,
      passedUserIds: [],
      createdAt: new Date().toISOString(),
    });
  }
}

module.exports = {
  findUserById,
  findUserByEmail,
  messageCountForTable,
  trustLadderFromCount,
  bestTrustLadderForUser,
  publicUser,
  blockedSetFor,
  isEitherBlocked,
  declinePendingInvitesBetween,
  authUser,
  profileFromBody,
  verificationPayload,
  verificationWithUser,
  publicProfile,
  publicProfileAsync,
  invitationPayload,
  tablePayload,
  messagePayload,
  backfillApprovedSelfies,
  ensureDemoUsers,
};
