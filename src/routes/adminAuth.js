const { createAsyncRouter } = require('../middleware/createAsyncRouter');
const { str } = require('../lib/util');
const { adminSessions, newToken } = require('../lib/tokens');
const { ADMIN_EMAIL, ADMIN_PASSWORD } = require('../config');

const router = createAsyncRouter();

router.post('/admin/auth/login', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = str(body.email).toLowerCase();
  const password = String(body.password || '').trim();
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (email !== ADMIN_EMAIL.toLowerCase() || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }
  const token = newToken();
  adminSessions.set(token, email);
  res.json({ token, email });
});


module.exports = { router };
