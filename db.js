const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const {
  User,
  Verification,
  Invitation,
  Table,
  Message,
  Counter,
} = require('./models');

const DATA_FILE = path.join(__dirname, 'data.json');

async function connectMongo(uri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log(`Connected to MongoDB: ${uri.replace(/\/\/.*@/, '//***@')}`);
}

async function getNextId(name) {
  const doc = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return doc.seq;
}

async function ensureCounter(name, minValue) {
  const current = await Counter.findById(name).lean();
  const seq = Math.max(Number(minValue) || 1, 1);
  if (!current || current.seq < seq - 1) {
    await Counter.findByIdAndUpdate(
      name,
      { seq: seq - 1 },
      { upsert: true },
    );
  }
}

function stripMongoId(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete obj._id;
  delete obj.__v;
  return obj;
}

async function migrateFromJsonIfEmpty() {
  const userCount = await User.countDocuments();
  if (userCount > 0) {
    console.log(`MongoDB already has ${userCount} users — skipping data.json import`);
    return;
  }
  if (!fs.existsSync(DATA_FILE)) {
    console.log('No data.json found — starting with empty MongoDB');
    return;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to parse data.json for migration', err);
    return;
  }

  const users = Array.isArray(raw.users) ? raw.users : [];
  const verifications = Array.isArray(raw.verifications) ? raw.verifications : [];
  const invitations = Array.isArray(raw.invitations) ? raw.invitations : [];
  const tables = Array.isArray(raw.tables) ? raw.tables : [];
  const messages = Array.isArray(raw.messages) ? raw.messages : [];

  if (users.length) {
    await User.insertMany(
      users.map((u) => ({
        ...u,
        passedUserIds: Array.isArray(u.passedUserIds) ? u.passedUserIds : [],
      })),
      { ordered: false },
    );
  }
  if (verifications.length) {
    await Verification.insertMany(verifications, { ordered: false });
  }
  if (invitations.length) {
    await Invitation.insertMany(invitations, { ordered: false });
  }
  if (tables.length) {
    await Table.insertMany(tables, { ordered: false });
  }
  if (messages.length) {
    await Message.insertMany(messages, { ordered: false });
  }

  const maxUserId = users.reduce((m, u) => Math.max(m, Number(u.id) || 0), 0);
  const maxVerId = verifications.reduce(
    (m, v) => Math.max(m, Number(v.id) || 0),
    0,
  );
  const maxInvId = invitations.reduce(
    (m, i) => Math.max(m, Number(i.id) || 0),
    0,
  );
  const maxTableId = tables.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
  const maxMsgId = messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);

  await ensureCounter('userId', Math.max(Number(raw.nextUserId) || 1, maxUserId + 1));
  await ensureCounter(
    'verificationId',
    Math.max(Number(raw.nextVerificationId) || 1, maxVerId + 1),
  );
  await ensureCounter(
    'invitationId',
    Math.max(Number(raw.nextInvitationId) || 1, maxInvId + 1),
  );
  await ensureCounter(
    'tableId',
    Math.max(Number(raw.nextTableId) || 1, maxTableId + 1),
  );
  await ensureCounter(
    'messageId',
    Math.max(Number(raw.nextMessageId) || 1, maxMsgId + 1),
  );

  console.log(
    `Migrated from data.json: ${users.length} users, ${verifications.length} verifications, ${invitations.length} invitations, ${tables.length} tables, ${messages.length} messages`,
  );
}

async function syncCountersFromData() {
  const [maxUser, maxVer, maxInv, maxTable, maxMsg] = await Promise.all([
    User.findOne().sort({ id: -1 }).select('id').lean(),
    Verification.findOne().sort({ id: -1 }).select('id').lean(),
    Invitation.findOne().sort({ id: -1 }).select('id').lean(),
    Table.findOne().sort({ id: -1 }).select('id').lean(),
    Message.findOne().sort({ id: -1 }).select('id').lean(),
  ]);
  await ensureCounter('userId', (maxUser?.id || 0) + 1);
  await ensureCounter('verificationId', (maxVer?.id || 0) + 1);
  await ensureCounter('invitationId', (maxInv?.id || 0) + 1);
  await ensureCounter('tableId', (maxTable?.id || 0) + 1);
  await ensureCounter('messageId', (maxMsg?.id || 0) + 1);
}

module.exports = {
  connectMongo,
  getNextId,
  migrateFromJsonIfEmpty,
  syncCountersFromData,
  stripMongoId,
  DATA_FILE,
};
