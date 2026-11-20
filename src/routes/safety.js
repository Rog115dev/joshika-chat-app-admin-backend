const { Report } = require('../models');
const { getNextId } = require('../db');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireApprovedUser } = require('../middleware/auth');
const { str } = require('../lib/util');
const { logger } = require('../logger');
const {
  findUserById,
  declinePendingInvitesBetween,
} = require('../services/users');

const router = createAsyncRouter();

router.post('/safety/report', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const reportedUserId = Number.parseInt(String(body.reportedUserId || ''), 10);
    const reason = str(body.reason).toLowerCase() || 'other';
    const details = str(body.details);
    const context = str(body.context) || 'profile';
    const tableIdRaw = body.tableId;
    const invitationIdRaw = body.invitationId;
    const tableId =
      tableIdRaw == null || tableIdRaw === ''
        ? null
        : Number.parseInt(String(tableIdRaw), 10);
    const invitationId =
      invitationIdRaw == null || invitationIdRaw === ''
        ? null
        : Number.parseInt(String(invitationIdRaw), 10);

    if (!Number.isFinite(reportedUserId)) {
      return res.status(400).json({ error: 'reportedUserId required' });
    }
    if (reportedUserId === me.id) {
      return res.status(400).json({ error: 'Cannot report yourself' });
    }
    if (!REPORT_REASONS.has(reason)) {
      return res.status(400).json({ error: 'Invalid report reason' });
    }
    const target = await findUserById(reportedUserId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const report = await Report.create({
      id: await getNextId('reportId'),
      reporterId: me.id,
      reportedUserId,
      reason,
      details,
      context,
      tableId: Number.isFinite(tableId) ? tableId : null,
      invitationId: Number.isFinite(invitationId) ? invitationId : null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    res.status(201).json({
      ok: true,
      report: {
        id: report.id,
        reportedUserId: report.reportedUserId,
        reason: report.reason,
        status: report.status,
        createdAt: report.createdAt,
      },
    });
  } catch (err) {
    logger.error('safety report failed', { err });
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

router.post('/safety/block', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const userId = Number.parseInt(String(body.userId || ''), 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'userId required' });
    }
    if (userId === me.id) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }
    const target = await findUserById(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!Array.isArray(me.blockedUserIds)) me.blockedUserIds = [];
    if (!me.blockedUserIds.includes(userId)) {
      me.blockedUserIds.push(userId);
    }
    // Also hide from browse via Pass list.
    if (!Array.isArray(me.passedUserIds)) me.passedUserIds = [];
    if (!me.passedUserIds.includes(userId)) {
      me.passedUserIds.push(userId);
    }
    await me.save();
    const declined = await declinePendingInvitesBetween(me.id, userId);
    res.json({
      ok: true,
      blockedUserId: userId,
      declinedInvitations: declined,
    });
  } catch (err) {
    logger.error('safety block failed', { err });
    res.status(500).json({ error: 'Failed to block user' });
  }
});

router.post('/safety/unblock', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const userId = Number.parseInt(String(body.userId || ''), 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'userId required' });
    }
    if (!Array.isArray(me.blockedUserIds)) me.blockedUserIds = [];
    me.blockedUserIds = me.blockedUserIds.filter((id) => id !== userId);
    await me.save();
    res.json({ ok: true, unblockedUserId: userId });
  } catch (err) {
    logger.error('safety unblock failed', { err });
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});


module.exports = { router };
