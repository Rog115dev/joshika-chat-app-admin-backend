const bcrypt = require('bcryptjs');
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

const router = createAsyncRouter();

router.get('/id-verifications', async (req, res) => {
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
    logger.error('list verifications failed', { err });
    res.status(500).json({ error: 'Failed to list verifications' });
  }
});

router.get('/id-verifications/:id', async (req, res) => {
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
    logger.error('get verification failed', { err });
    res.status(500).json({ error: 'Failed to get verification' });
  }
});

router.post('/id-verifications', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const profile = profileFromBody(body);
    let user = await authUser(req);

    if (!user && profile.email && profile.password) {
      // Never reuse / overwrite an existing account on register.
      // Same email must always 409 — do not reset verificationStatus to pending.
      const existing = await findUserByEmail(profile.email);
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      if (!profile.age || profile.age < 18) {
        return res.status(400).json({
          error: 'You must be 18 or older to register',
        });
      }
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
    logger.error('create verification failed', { err });
    res.status(500).json({ error: 'Submission failed' });
  }
});

router.patch('/id-verifications/:id', async (req, res) => {
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
    logger.error('patch verification failed', { err });
    res.status(500).json({ error: 'Update failed' });
  }
});


module.exports = { router };
