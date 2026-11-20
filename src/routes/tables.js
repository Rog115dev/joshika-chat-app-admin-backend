const { Table, Message } = require('../models');
const { getNextId } = require('../db');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireApprovedUser } = require('../middleware/auth');
const { str } = require('../lib/util');
const { logger } = require('../logger');
const {
  findUserById,
  isEitherBlocked,
  tablePayload,
  messagePayload,
} = require('../services/users');

const router = createAsyncRouter();

router.get('/tables/:id', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const table = await Table.findOne({ id }).lean();
  if (!table) return res.status(404).json({ error: 'Not found' });
  if (table.hostUserId !== me.id && table.guestUserId !== me.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await tablePayload(table));
});

router.get('/tables/:id/messages', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  const id = Number.parseInt(req.params.id, 10);
  const table = await Table.findOne({ id }).lean();
  if (!table) return res.status(404).json({ error: 'Not found' });
  if (table.hostUserId !== me.id && table.guestUserId !== me.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const rows = await Message.find({ tableId: id }).sort({ id: 1 });
  res.json(await Promise.all(rows.map((m) => messagePayload(m))));
});

router.post('/tables/:id/messages', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const id = Number.parseInt(req.params.id, 10);
    const table = await Table.findOne({ id });
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

    const msg = await Message.create({
      id: await getNextId('messageId'),
      tableId: id,
      senderId: me.id,
      text,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(await messagePayload(msg));
  } catch (err) {
    logger.error('post message failed', { err });
    res.status(500).json({ error: 'Failed to send message' });
  }
});

router.get('/tables', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    const statusRaw = str(req.query.status).toLowerCase();
    const includeAll = ['all', 'any', 'history'].includes(statusRaw);
    const statusFilter = includeAll ? null : statusRaw || 'active';
    const filter = {
      $or: [{ hostUserId: me.id }, { guestUserId: me.id }],
    };
    if (statusFilter != null) filter.status = statusFilter;

    let rows = await Table.find(filter).lean();
    const visible = [];
    for (const t of rows) {
      const peerId = t.hostUserId === me.id ? t.guestUserId : t.hostUserId;
      const peer = await findUserById(peerId);
      if (peer && isEitherBlocked(me, peer)) continue;
      visible.push(t);
    }
    rows = visible;
    const withLast = await Promise.all(
      rows.map(async (t) => {
        const last = await Message.findOne({ tableId: t.id })
          .sort({ id: -1 })
          .select('id')
          .lean();
        return { table: t, lastId: last?.id || 0 };
      }),
    );
    withLast.sort((a, b) => {
      if (b.lastId !== a.lastId) return b.lastId - a.lastId;
      return b.table.id - a.table.id;
    });
    res.json(
      await Promise.all(withLast.map(({ table }) => tablePayload(table, me.id))),
    );
  } catch (err) {
    logger.error('list tables failed', { err });
    res.status(500).json({ error: 'Failed to list tables' });
  }
});

router.get('/chats', async (req, res) => {
  const me = await requireApprovedUser(req, res);
  if (!me) return;
  try {
    let rows = await Table.find({
      $or: [{ hostUserId: me.id }, { guestUserId: me.id }],
    }).lean();
    const visible = [];
    for (const t of rows) {
      const peerId = t.hostUserId === me.id ? t.guestUserId : t.hostUserId;
      const peer = await findUserById(peerId);
      if (peer && isEitherBlocked(me, peer)) continue;
      visible.push(t);
    }
    const withLast = await Promise.all(
      visible.map(async (t) => {
        const last = await Message.findOne({ tableId: t.id })
          .sort({ id: -1 })
          .select('id')
          .lean();
        return { table: t, lastId: last?.id || 0 };
      }),
    );
    withLast.sort((a, b) => {
      if (b.lastId !== a.lastId) return b.lastId - a.lastId;
      return b.table.id - a.table.id;
    });
    res.json(
      await Promise.all(withLast.map(({ table }) => tablePayload(table, me.id))),
    );
  } catch (err) {
    logger.error('list chats failed', { err });
    res.status(500).json({ error: 'Failed to list chats' });
  }
});


module.exports = { router };
