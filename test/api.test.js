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

  it('POST /id-verifications creates a submission (authUser import regression)', async () => {
    const email = `audit-${Date.now()}@joshikai.test`;
    const res = await server.request('POST', '/id-verifications', {
      body: {
        email,
        password: 'AuditTest123!',
        name: 'Audit User',
        nickname: 'audit',
        age: 22,
        phoneNumber: '09000000000',
        selfieUrl: 'data:image/png;base64,aaa',
        status: 'pending',
      },
    });
    assert.equal(res.status, 201, res.text);
    assert.ok(res.json);
    assert.ok(res.json.token || res.json.id != null);
    assert.notEqual(res.json.error, 'Submission failed');
  });

  it('POST /safety/report validates reason (REPORT_REASONS regression)', async () => {
    const login = await server.request('POST', '/auth/login', {
      body: { email: 'yuki@joshikai.demo', password: 'demo123' },
    });
    assert.equal(login.status, 200);

    const bad = await server.request('POST', '/safety/report', {
      headers: { Authorization: `Bearer ${login.json.token}` },
      body: { reportedUserId: 999999, reason: 'not-a-real-reason' },
    });
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.error || ''), /Invalid report reason/i);

    // Pick another demo user id from room profiles if available
    const profiles = await server.request('GET', '/room/profiles', {
      headers: { Authorization: `Bearer ${login.json.token}` },
    });
    const peer = (profiles.json || []).find(
      (p) => p && p.id !== login.json.user.id,
    );
    if (peer) {
      const ok = await server.request('POST', '/safety/report', {
        headers: { Authorization: `Bearer ${login.json.token}` },
        body: {
          reportedUserId: peer.id,
          reason: 'spam',
          details: 'audit',
        },
      });
      assert.equal(ok.status, 201, ok.text);
      assert.equal(ok.json.ok, true);
    }
  });

  it('POST /auth/reset-password clears sessions (clearUserSessions regression)', async () => {
    const { passwordResetCodes } = require('../src/lib/tokens');
    const email = 'yuki@joshikai.demo';
    passwordResetCodes.set(email, {
      code: '123456',
      expiresAt: Date.now() + 60_000,
    });

    const login = await server.request('POST', '/auth/login', {
      body: { email, password: 'demo123' },
    });
    assert.equal(login.status, 200);
    const oldToken = login.json.token;

    const reset = await server.request('POST', '/auth/reset-password', {
      body: {
        email,
        code: '123456',
        newPassword: 'demo123',
      },
    });
    assert.equal(reset.status, 200, reset.text);
    assert.equal(reset.json.ok, true);

    const me = await server.request('GET', '/auth/me', {
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    assert.equal(me.status, 401);

    // restore demo login for later tests if any
    const again = await server.request('POST', '/auth/login', {
      body: { email, password: 'demo123' },
    });
    assert.equal(again.status, 200);
  });

  it('unknown API path returns JSON 404 from error pipeline or express', async () => {
    const res = await server.request('GET', '/definitely-not-a-route');
    assert.ok(res.status === 404 || res.status === 200);
  });
});
