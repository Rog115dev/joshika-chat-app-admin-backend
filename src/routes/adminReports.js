const { Report } = require('../models');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireAdmin } = require('../middleware/auth');
const { str, stripMongoId } = require('../lib/util');
const { logger } = require('../logger');
const { findUserById } = require('../services/users');

const router = createAsyncRouter();

router.get('/admin/reports', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const status = str(req.query.status) || 'pending';
    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(String(req.query.limit || '50'), 10) || 50),
    );
    const filter = status === 'all' ? {} : { status };
    const rows = await Report.find(filter).sort({ id: -1 }).limit(limit).lean();
    const enriched = await Promise.all(
      rows.map(async (r) => {
        const reporter = await findUserById(r.reporterId);
        const reported = await findUserById(r.reportedUserId);
        return {
          ...r,
          reporter: reporter
            ? {
                id: reporter.id,
                email: reporter.email,
                nickname: reporter.nickname || reporter.name || '',
              }
            : null,
          reportedUser: reported
            ? {
                id: reported.id,
                email: reported.email,
                nickname: reported.nickname || reported.name || '',
                verificationStatus: reported.verificationStatus || 'pending',
              }
            : null,
        };
      }),
    );
    res.json(enriched);
  } catch (err) {
    logger.error('admin reports failed', { err });
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

router.patch('/admin/reports/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = Number.parseInt(req.params.id, 10);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const report = await Report.findOne({ id });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const status = str(body.status).toLowerCase();
    if (status && ['pending', 'reviewed', 'dismissed'].includes(status)) {
      report.status = status;
      if (status !== 'pending') {
        report.reviewedAt = new Date().toISOString();
      }
    }
    if (body.adminNote != null) report.adminNote = str(body.adminNote);
    await report.save();
    res.json({ ok: true, report: stripMongoId(report) });
  } catch (err) {
    logger.error('admin report patch failed', { err });
    res.status(500).json({ error: 'Failed to update report' });
  }
});


module.exports = { router };
