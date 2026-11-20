const { Invitation, Table, Message } = require('../models');
const { getNextId } = require('../db');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireApprovedUser } = require('../middleware/auth');
const { str } = require('../lib/util');
const { logger } = require('../logger');
const {
  findUserById,
  isEitherBlocked,
  invitationPayload,
} = require('../services/users');

const router = createAsyncRouter();

router.post('/invitations', async (req, res) => {
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
    if (isEitherBlocked(me, toUser)) {
      return res.status(403).json({ error: 'Cannot invite a blocked member' });
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
    logger.error('create invitation failed', { err });
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

router.get('/invitations', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  const box = str(req.query.box) || 'incoming';
  const status = str(req.query.status);

  const filter =
    box === 'outgoing' ? { fromUserId: me.id } : { toUserId: me.id };
  if (status) filter.status = status;

  let rows = await Invitation.find(filter).sort({ id: -1 });
  // Hide invites involving blocked members.
  const filtered = [];
  for (const inv of rows) {
    const otherId = box === 'outgoing' ? inv.toUserId : inv.fromUserId;
    const other = await findUserById(otherId);
    if (other && isEitherBlocked(me, other)) continue;
    filtered.push(inv);
  }
  res.json(await Promise.all(filtered.map((inv) => invitationPayload(inv))));
});

router.get('/invitations/:id', async (req, res) => {
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

router.post('/invitations/:id/accept', async (req, res) => {
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
    logger.error('accept invitation failed', { err });
    res.status(500).json({ error: 'Accept failed' });
  }
});

router.post('/invitations/:id/decline', async (req, res) => {
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
    logger.error('decline invitation failed', { err });
    res.status(500).json({ error: 'Decline failed' });
  }
});


module.exports = { router };
