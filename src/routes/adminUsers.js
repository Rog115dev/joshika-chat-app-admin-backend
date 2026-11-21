const bcrypt = require('bcryptjs');
const { User, Verification, Invitation, Table, Message } = require('../models');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireAdmin } = require('../middleware/auth');
const { str } = require('../lib/util');
const { clearUserSessions } = require('../lib/tokens');
const { normalizeImageUrl, applyApprovedSelfieToProfile } = require('../lib/images');
const { logger } = require('../logger');
const {
  findUserById,
  findUserByEmail,
  publicUser,
} = require('../services/users');

const router = createAsyncRouter();

router.get('/admin/users', async (req, res) => {
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
    logger.error('admin users list failed', { err });
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.get('/admin/users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number.parseInt(req.params.id, 10);
  const user = await findUserById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: await publicUser(user) });
});

router.patch('/admin/users/:id', async (req, res) => {
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
    logger.error('admin patch user failed', { err });
    res.status(500).json({ error: 'Update failed' });
  }
});

router.post('/admin/users/:id/reset-password', async (req, res) => {
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
    logger.error('admin reset-password failed', { err });
    res.status(500).json({ error: 'Reset failed' });
  }
});

router.delete('/admin/users/:id', async (req, res) => {
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
    logger.error('admin delete user failed', { err });
    res.status(500).json({ error: 'Delete failed' });
  }
});


module.exports = { router };
