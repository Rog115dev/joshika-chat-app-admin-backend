const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { normalizeImageUrl, isUsableSelfieUrl, latestVerificationForUser, isPrivateHostname } = require('../lib/images');
const { findUserById } = require('../services/users');
const { logger } = require('../logger');

const router = createAsyncRouter();

router.get('/media/selfie/:userId', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.userId, 10);
    const user = await findUserById(id);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const linked = await latestVerificationForUser(user);
    let selfie = normalizeImageUrl(linked?.selfieUrl || '');
    if (!isUsableSelfieUrl(selfie)) {
      selfie = normalizeImageUrl(user.profileImageUrl);
    }
    if (selfie.startsWith('data:image') && selfie.includes(',')) {
      const comma = selfie.indexOf(',');
      const meta = selfie.slice(0, comma);
      const b64 = selfie.slice(comma + 1);
      const mimeMatch = /data:(image\/[a-zA-Z0-9.+-]+)/i.exec(meta);
      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      try {
        const buf = Buffer.from(b64, 'base64');
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.send(buf);
      } catch {
        return res.status(500).json({ error: 'Invalid selfie data' });
      }
    }
    if (/^https?:\/\//i.test(selfie) && !selfie.includes('/media/selfie/')) {
      return res.redirect(302, selfie);
    }
    return res.status(404).json({ error: 'No selfie on file' });
  } catch (err) {
    logger.error('selfie media failed', { err });
    res.status(500).json({ error: 'Failed to load selfie' });
  }
});

router.get('/media/image', async (req, res) => {
  const raw = typeof req.query.u === 'string' ? req.query.u : '';
  const target = normalizeImageUrl(raw);
  if (!/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: 'Invalid image URL' });
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Invalid image URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateHostname(parsed.hostname)) {
    return res.status(400).json({ error: 'URL not allowed' });
  }
  try {
    const upstream = await fetch(target, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; JoshikaiAvatarProxy/1.0; +https://joshikai.local)',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Upstream image fetch failed' });
    }
    let contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim();
    if (!contentType.toLowerCase().startsWith('image/')) {
      return res.status(415).json({ error: 'URL is not an image' });
    }
    let buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image too large' });
    }

    const lowerType = contentType.toLowerCase();
    const looksAvif =
      lowerType.includes('avif') ||
      lowerType.includes('heic') ||
      lowerType.includes('heif') ||
      /\.avif(\?|$)/i.test(parsed.pathname);
    if (looksAvif) {
      try {
        const sharp = require('sharp');
        buf = await sharp(buf).rotate().jpeg({ quality: 85 }).toBuffer();
        contentType = 'image/jpeg';
      } catch (convErr) {
        logger.warn(String('Avatar convert failed:', convErr.message));
        return res.status(415).json({ error: 'Unsupported image format for app' });
      }
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (_err) {
    res.status(502).json({ error: 'Could not load image' });
  }
});


module.exports = { router };
