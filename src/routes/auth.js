const bcrypt = require('bcryptjs');
const { User, Verification } = require('../models');
const { getNextId } = require('../db');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { str } = require('../lib/util');
const {
  userSessions,
  passwordResetCodes,
  newToken,
  clearUserSessions,
} = require('../lib/tokens');
const { RESEND_API_KEY } = require('../config');
const { logger } = require('../logger');
const { makeResetCode, sendPasswordResetEmail } = require('../services/mail');
const {
  findUserByEmail,
  publicUser,
  authUser,
  profileFromBody,
} = require('../services/users');

const router = createAsyncRouter();

router.post('/auth/register', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const profile = profileFromBody(body);
    if (!profile.email || !profile.password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    if (await findUserByEmail(profile.email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    if (!profile.age || profile.age < 18) {
      return res.status(400).json({
        error: 'You must be 18 or older to register',
      });
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
    logger.error('register failed', { err });
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/auth/login', async (req, res) => {
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
    logger.error('login failed', { err });
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/auth/check-email', async (req, res) => {
  const email = str(req.query.email).toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'email required' });
  }
  const user = await findUserByEmail(email);
  res.json({ exists: !!user, email });
});

router.post('/auth/forgot-password', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = str(body.email).toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const user = await findUserByEmail(email);
  if (!user) {
    return res.status(404).json({
      error: 'This email is not registered',
      code: 'EMAIL_NOT_REGISTERED',
    });
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
    logger.error('Password reset email failed', { message: e.message || e });
    return res.status(502).json({
      error:
        e.code === 'NO_RESEND_KEY'
          ? e.message
          : 'Could not send reset email. Please try again later.',
    });
  }

  res.json({ ok: true, sent: true });
});

router.post('/auth/reset-password', async (req, res) => {
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

    // Password only — do not change verificationStatus / Verification records.
    const previousStatus = String(user.verificationStatus || 'pending');
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    clearUserSessions(user.id);
    passwordResetCodes.delete(email);
    res.json({
      ok: true,
      verificationStatus: previousStatus,
      requiresReapproval: false,
    });
  } catch (err) {
    logger.error('reset-password failed', { err });
    res.status(500).json({ error: 'Password reset failed' });
  }
});

router.get('/auth/me', async (req, res) => {
  const user = await authUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ user: await publicUser(user) });
});

router.patch('/auth/me', async (req, res) => {
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
    logger.error('patch /auth/me failed', { err });
    res.status(500).json({ error: 'Update failed' });
  }
});

router.get('/auth/status', async (req, res) => {
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


module.exports = { router };
