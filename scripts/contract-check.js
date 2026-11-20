/**
 * Deep contract smoke check vs expected original API shapes.
 * Exit 1 on failure.
 */
const { startTestServer } = require('../test/helpers');
const { ADMIN_EMAIL, ADMIN_PASSWORD } = require('../src/config');

const failures = [];

function fail(msg) {
  failures.push(msg);
  console.error('FAIL:', msg);
}

function ok(msg) {
  console.log('OK  ', msg);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
  else ok(msg);
}

async function main() {
  const server = await startTestServer();
  try {
    // Health — legacy keys must remain
    {
      const res = await server.request('GET', '/health');
      assert(res.status === 200, `GET /health status ${res.status}`);
      const j = res.json || {};
      for (const k of [
        'ok',
        'mongo',
        'users',
        'verifications',
        'selfieMedia',
        'build',
      ]) {
        assert(k in j, `GET /health has ${k}`);
      }
      assert(j.selfieMedia === true, 'GET /health selfieMedia true');
      assert(j.build === 'mongo-v1', 'GET /health build mongo-v1');
      assert(Array.isArray(j.status), 'GET /health status[] present');
      assert(typeof j.statusText === 'string', 'GET /health statusText present');
    }

    // Admin login shape
    {
      const bad = await server.request('POST', '/admin/auth/login', {
        body: { email: ADMIN_EMAIL, password: 'nope' },
      });
      assert(bad.status === 401, 'admin login bad password -> 401');
      assert(!!bad.json?.error, 'admin login error field');

      const good = await server.request('POST', '/admin/auth/login', {
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      assert(good.status === 200, 'admin login 200');
      assert(typeof good.json?.token === 'string', 'admin login token');
      assert(
        String(good.json?.email).toLowerCase() === ADMIN_EMAIL.toLowerCase(),
        'admin login email',
      );

      const users = await server.request('GET', '/admin/users', {
        headers: { Authorization: `Bearer ${good.json.token}` },
      });
      assert(users.status === 200, 'GET /admin/users 200');
      assert(Array.isArray(users.json), 'GET /admin/users array');
      if (users.json.length) {
        const u = users.json[0];
        assert('id' in u && 'email' in u, 'admin user has id+email');
        assert(!('passwordHash' in u), 'admin user hides passwordHash');
      }

      const backups = await server.request('GET', '/admin/backups', {
        headers: { Authorization: `Bearer ${good.json.token}` },
      });
      assert(backups.status === 200, 'GET /admin/backups 200');
      assert(Array.isArray(backups.json), 'GET /admin/backups array');

      const reports = await server.request('GET', '/admin/reports?status=pending', {
        headers: { Authorization: `Bearer ${good.json.token}` },
      });
      assert(reports.status === 200, 'GET /admin/reports 200');
      assert(Array.isArray(reports.json), 'GET /admin/reports array');
    }

    // User auth + room
    {
      const login = await server.request('POST', '/auth/login', {
        body: { email: 'yuki@joshikai.demo', password: 'demo123' },
      });
      assert(login.status === 200, 'user login 200');
      assert(login.json?.token && login.json?.user, 'user login {token,user}');
      assert(login.json.user.email === 'yuki@joshikai.demo', 'user email');
      assert(!('passwordHash' in login.json.user), 'user hides passwordHash');
      assert('trustLadder' in login.json.user, 'user has trustLadder');

      const me = await server.request('GET', '/auth/me', {
        headers: { Authorization: `Bearer ${login.json.token}` },
      });
      assert(me.status === 200 && me.json?.user, 'GET /auth/me');

      const profiles = await server.request('GET', '/room/profiles', {
        headers: { Authorization: `Bearer ${login.json.token}` },
      });
      assert(profiles.status === 200, 'GET /room/profiles 200');
      assert(Array.isArray(profiles.json), 'room profiles array');

      const invites = await server.request('GET', '/invitations?box=incoming', {
        headers: { Authorization: `Bearer ${login.json.token}` },
      });
      assert(invites.status === 200, 'GET /invitations 200');
      assert(Array.isArray(invites.json), 'invitations array');

      const chats = await server.request('GET', '/chats', {
        headers: { Authorization: `Bearer ${login.json.token}` },
      });
      assert(chats.status === 200, 'GET /chats 200');
      assert(Array.isArray(chats.json), 'chats array');

      const tables = await server.request('GET', '/tables', {
        headers: { Authorization: `Bearer ${login.json.token}` },
      });
      assert(tables.status === 200, 'GET /tables 200');
      assert(Array.isArray(tables.json), 'tables array');
    }

    // Public-ish
    {
      const check = await server.request(
        'GET',
        '/auth/check-email?email=yuki@joshikai.demo',
      );
      assert(check.status === 200, 'GET /auth/check-email 200');
      assert(check.json?.exists === true, 'check-email exists true');

      const status = await server.request(
        'GET',
        '/auth/status?email=yuki@joshikai.demo',
      );
      assert(status.status === 200, 'GET /auth/status 200');
      assert('verificationStatus' in (status.json || {}), 'auth/status field');

      const vers = await server.request(
        'GET',
        '/id-verifications?status=pending&limit=5',
      );
      assert(vers.status === 200, 'GET /id-verifications 200');
      assert(Array.isArray(vers.json), 'verifications array');
    }

    // Auth gates
    {
      const a = await server.request('GET', '/admin/users');
      assert(a.status === 401, 'admin users without token -> 401');
      const b = await server.request('GET', '/room/profiles');
      assert(b.status === 401, 'room profiles without token -> 401');
      const c = await server.request('GET', '/admin/backups');
      assert(c.status === 401, 'backups without token -> 401');
    }

    // Admin static
    {
      const admin = await server.request('GET', '/admin/');
      assert(admin.status === 200, 'GET /admin/ 200');
      assert(
        /joshikai|html/i.test(admin.text || ''),
        'admin page html content',
      );
    }

    // Forced handler error should not kill — hit health after bad body
    {
      const bad = await server.request('POST', '/auth/login', {
        headers: { 'Content-Type': 'application/json' },
        body: undefined,
      });
      // empty body with content-type may 400 or 401
      assert(
        [200, 400, 401, 500].includes(bad.status),
        `odd login still responds (${bad.status})`,
      );
      const health = await server.request('GET', '/health');
      assert(health.status === 200, 'health still works after odd request');
    }
  } finally {
    await server.close();
  }

  console.log('\n---');
  if (failures.length) {
    console.error(`${failures.length} contract check(s) failed`);
    process.exit(1);
  }
  console.log('All contract checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
