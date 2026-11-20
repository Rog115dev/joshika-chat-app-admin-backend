const fs = require('fs');
const path = require('path');
const express = require('express');
const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { requireAdmin } = require('../middleware/auth');
const { logger } = require('../logger');
const {
  BACKUP_DIR,
  ensureBackupDir,
  backupFilenameFor,
  sanitizeBackupUploadName,
  uniqueBackupFilename,
  resolveBackupFile,
  encryptBackupPayload,
  loadBackupPayload,
  validateEncryptedBackupBuffer,
  buildBackupPayload,
  readBackupMeta,
  restoreFromBackupData,
  listBackupMetas,
} = require('../lib/backup');

const router = createAsyncRouter();

router.get('/admin/backups', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const items = listBackupMetas();
    res.json(items);
  } catch (err) {
    logger.error('list backups failed', { err });
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

router.post('/admin/backups', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    ensureBackupDir();
    const payload = await buildBackupPayload();
    const filename = backupFilenameFor(payload.backedUpAt);
    const full = path.join(BACKUP_DIR, filename);
    const encrypted = encryptBackupPayload(payload);
    fs.writeFileSync(full, encrypted);
    const meta = readBackupMeta(full, filename);
    res.status(201).json(meta);
  } catch (err) {
    logger.error('create backup failed', { err });
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

router.post(
  '/admin/backups/upload',
  express.raw({ type: () => true, limit: '80mb' }),
  async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      ensureBackupDir();
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      if (!buf.length) {
        return res.status(400).json({ error: 'ファイルが空です' });
      }
      let data;
      try {
        data = validateEncryptedBackupBuffer(buf);
      } catch (err) {
        const code = err && err.message;
        if (code === 'magic' || code === 'empty') {
          return res.status(400).json({
            error: 'Joshikai のバックアップファイルではありません',
          });
        }
        if (code === 'payload') {
          return res.status(400).json({
            error: 'バックアップの内容が不完全です',
          });
        }
        return res.status(400).json({
          error:
            'このバックアップは読み取れません（破損、または別の暗号化キー）',
        });
      }
      let suggested =
        typeof req.query.name === 'string'
          ? req.query.name
          : typeof req.headers['x-backup-filename'] === 'string'
            ? req.headers['x-backup-filename']
            : '';
      try {
        suggested = decodeURIComponent(suggested);
      } catch (_) {
        /* keep raw */
      }
      const preferred = sanitizeBackupUploadName(
        suggested,
        data.backedUpAt || new Date().toISOString(),
      );
      const { filename, full } = uniqueBackupFilename(preferred);
      fs.writeFileSync(full, buf);
      const meta = readBackupMeta(full, filename);
      res.status(201).json(meta);
    } catch (err) {
      logger.error('upload backup failed', { err });
      res.status(500).json({ error: 'アップロードに失敗しました' });
    }
  },
);

router.get('/admin/backups/:filename/download', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const resolved = resolveBackupFile(req.params.filename);
    if (!resolved || !fs.existsSync(resolved.full)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.download(resolved.full, resolved.filename);
  } catch (err) {
    logger.error('download backup failed', { err });
    res.status(500).json({ error: 'Failed to download backup' });
  }
});

router.post('/admin/backups/:filename/restore', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const resolved = resolveBackupFile(req.params.filename);
    if (!resolved || !fs.existsSync(resolved.full)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    let data;
    try {
      data = loadBackupPayload(resolved.full);
    } catch {
      return res.status(400).json({
        error: 'このバックアップは復元できません（破損または別のキーで暗号化）',
      });
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.users)) {
      return res.status(400).json({
        error: 'バックアップの内容が不完全です',
      });
    }
    const restored = await restoreFromBackupData(data);
    res.json({
      ok: true,
      filename: resolved.filename,
      backedUpAt: data.backedUpAt || null,
      restored,
    });
  } catch (err) {
    logger.error('restore backup failed', { err });
    res.status(500).json({ error: 'Failed to restore backup' });
  }
});

router.delete('/admin/backups/:filename', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const resolved = resolveBackupFile(req.params.filename);
    if (!resolved || !fs.existsSync(resolved.full)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    fs.unlinkSync(resolved.full);
    res.json({ ok: true, filename: resolved.filename });
  } catch (err) {
    logger.error('delete backup failed', { err });
    res.status(500).json({ error: 'Failed to delete backup' });
  }
});

module.exports = { router };
