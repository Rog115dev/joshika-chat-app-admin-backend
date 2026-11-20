const dns = require('dns');
const mongoose = require('mongoose');
const {
  User,
  Verification,
  Invitation,
  Table,
  Message,
  Counter,
} = require('./models');

/**
 * Many VPS / Windows hosts use a broken local DNS stub (127.0.0.1) that
 * refuses MongoDB Atlas SRV lookups (querySrv ECONNREFUSED). Prefer public DNS.
 */
function ensurePublicDnsForAtlas() {
  try {
    const current = dns.getServers();
    const brokenLocal =
      !current.length ||
      current.every((s) => s === '127.0.0.1' || s === '::1');
    if (brokenLocal || process.env.MONGODB_FORCE_PUBLIC_DNS === '1') {
      dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
      console.log(
        `MongoDNS: using public resolvers (was: ${current.join(', ') || 'none'})`,
      );
    }
  } catch (err) {
    console.warn('MongoDNS: could not adjust resolvers', err.message || err);
  }
}

async function connectMongo(uri) {
  mongoose.set('strictQuery', true);
  ensurePublicDnsForAtlas();
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 20000,
    });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // Retry once with forced public DNS if SRV lookup failed.
    if (/querySrv|ECONNREFUSED|ENOTFOUND|EREFUSED/i.test(msg)) {
      console.warn(`MongoDNS: connect failed (${msg}); forcing 8.8.8.8 / 1.1.1.1`);
      dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 20000,
      });
    } else {
      throw err;
    }
  }
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
  syncCountersFromData,
  stripMongoId,
};
