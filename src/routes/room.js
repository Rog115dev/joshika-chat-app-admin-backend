const { User } = require('../models');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireApprovedUser } = require('../middleware/auth');
const { str } = require('../lib/util');
const { logger } = require('../logger');
const {
  findUserById,
  isEitherBlocked,
  publicProfileAsync,
} = require('../services/users');

const router = createAsyncRouter();

router.get('/room/profiles', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;

  try {
    const passed = new Set(me.passedUserIds || []);
    const similarAge = String(req.query.similarAge || '') === '1';
    const nearby = String(req.query.nearby || '') === '1';
    const jpToEn = String(req.query.jpToEn || '') === '1';
    const enToJp = String(req.query.enToJp || '') === '1';
    const interest = str(req.query.interest);

    const filter = {
      id: { $ne: me.id },
      verificationStatus: 'approved',
    };
    if (passed.size) {
      filter.id = { $ne: me.id, $nin: [...passed] };
    }

    let rows = await User.find(filter);
    // Hide anyone I blocked or who blocked me.
    rows = rows.filter((u) => !isEitherBlocked(me, u));
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
    // Language direction: keep peers who share / complement the selected direction(s).
    if (jpToEn || enToJp) {
      rows = rows.filter((u) => {
        const peerJpToEn = u.jpToEnOn === true;
        const peerEnToJp = u.enToJpOn === true;
        if (!peerJpToEn && !peerEnToJp) return false;
        if (jpToEn && (peerJpToEn || peerEnToJp)) return true;
        if (enToJp && (peerJpToEn || peerEnToJp)) return true;
        return false;
      });
    }
    // Shared interests: peer must overlap the viewer on ≥1 interest key.
    // If the viewer has none saved yet, skip this gate (other filters still apply).
    const myInterests = new Set(
      (me.interests || [])
        .map((x) => String(x).trim().toLowerCase())
        .filter(Boolean),
    );
    if (myInterests.size > 0) {
      rows = rows.filter((u) =>
        (u.interests || []).some((x) =>
          myInterests.has(String(x).trim().toLowerCase()),
        ),
      );
    }
    // Optional single-interest pin from query (AND with shared-interest gate).
    if (interest) {
      const want = interest.toLowerCase();
      rows = rows.filter((u) =>
        (u.interests || []).some((x) => String(x).toLowerCase() === want),
      );
    }

    res.json(await Promise.all(rows.map((u) => publicProfileAsync(u))));
  } catch (err) {
    logger.error('room profiles failed', { err });
    res.status(500).json({ error: 'Failed to load profiles' });
  }
});

router.get('/room/profiles/:id', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const user = await findUserById(id);
  if (!user || String(user.verificationStatus || '').toLowerCase() !== 'approved') {
    return res.status(404).json({ error: 'Profile not found' });
  }
  res.json(await publicProfileAsync(user));
});

router.post('/room/pass', async (req, res) => {
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


module.exports = { router };
