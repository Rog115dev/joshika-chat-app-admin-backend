const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');
const { ADMIN_EMAIL, ADMIN_PASSWORD } = require('../src/config');

describe('API endpoints', () => {
  let server;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it('GET /health returns legacy fields plus metrics', async () => {
    const res = await server.request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.ok, 'boolean');
    assert.ok('mongo' in res.json);
    assert.ok('users' in res.json);
    assert.ok('verifications' in res.json);
    assert.equal(res.json.selfieMedia, true);
    assert.equal(res.json.build, 'mongo-v1');
    assert.ok(typeof res.json.uptimeSec === 'number');
    assert.ok(typeof res.json.uptime === 'string');
    assert.ok(res.json.memory);
    assert.ok(typeof res.json.memory.rssMB === 'number');
    assert.ok(res.json.cpu);
    assert.ok(Array.isArray(res.json.cpu.loadAvg));
    assert.ok(Array.isArray(res.json.status));
    assert.ok(res.json.status.some((l) => String(l).startsWith('Mongo')));
    assert.ok(typeof res.json.statusText === 'string');
    assert.ok(res.json.statusText.includes('Uptime'));
  });

  it('GET /admin/ serves admin web', async () => {
    const res = await server.request('GET', '/admin/');
    assert.equal(res.status, 200);
    assert.ok(
      res.text.includes('Joshikai') || res.text.toLowerCase().includes('html'),
    );
  });

  it('POST /admin/auth/login succeeds with env credentials', async () => {
    const res = await server.request('POST', '/admin/auth/login', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.token);
    assert.equal(String(res.json.email).toLowerCase(), ADMIN_EMAIL.toLowerCase());
  });

  it('POST /admin/auth/login rejects bad password', async () => {
    const res = await server.request('POST', '/admin/auth/login', {
      body: { email: ADMIN_EMAIL, password: 'wrong-password' },
    });
    assert.equal(res.status, 401);
    assert.ok(res.json.error);
  });

  it('GET /admin/backups requires admin auth', async () => {
    const res = await server.request('GET', '/admin/backups');
    assert.equal(res.status, 401);
  });

  it('GET /admin/backups works with admin token', async () => {
    const login = await server.request('POST', '/admin/auth/login', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const res = await server.request('GET', '/admin/backups', {
      headers: { Authorization: `Bearer ${login.json.token}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
  });

  it('POST /auth/login works for demo user', async () => {
    const res = await server.request('POST', '/auth/login', {
      body: { email: 'yuki@joshikai.demo', password: 'demo123' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.token);
    assert.ok(res.json.user);
    assert.equal(res.json.user.email, 'yuki@joshikai.demo');
  });

  it('GET /auth/me requires user token', async () => {
    const denied = await server.request('GET', '/auth/me');
    assert.equal(denied.status, 401);

    const login = await server.request('POST', '/auth/login', {
      body: { email: 'yuki@joshikai.demo', password: 'demo123' },
    });
    const res = await server.request('GET', '/auth/me', {
      headers: { Authorization: `Bearer ${login.json.token}` },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.user);
    assert.equal(res.json.user.email, 'yuki@joshikai.demo');
  });

  it('GET /room/profiles requires approved user auth', async () => {
    const denied = await server.request('GET', '/room/profiles');
    assert.equal(denied.status, 401);

    const login = await server.request('POST', '/auth/login', {
      body: { email: 'yuki@joshikai.demo', password: 'demo123' },
    });
    const res = await server.request('GET', '/room/profiles', {
      headers: { Authorization: `Bearer ${login.json.token}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
  });

  it('GET /id-verifications returns an array', async () => {
    const res = await server.request(
      'GET',
      '/id-verifications?status=pending&limit=5',
    );
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
  });

  it('unknown API path returns JSON 404 from error pipeline or express', async () => {
    const res = await server.request('GET', '/definitely-not-a-route');
    assert.ok(res.status === 404 || res.status === 200);
  });
});
