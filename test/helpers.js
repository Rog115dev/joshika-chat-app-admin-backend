const http = require('http');
const { loadEnv } = require('../src/loadEnv');

loadEnv();

function captureConsole() {
  const buckets = { log: [], warn: [], error: [], info: [], debug: [] };
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  console.log = (...args) => {
    buckets.log.push(args.map(String).join(' '));
  };
  console.warn = (...args) => {
    buckets.warn.push(args.map(String).join(' '));
  };
  console.error = (...args) => {
    buckets.error.push(args.map(String).join(' '));
  };
  console.info = (...args) => {
    buckets.info.push(args.map(String).join(' '));
  };
  console.debug = (...args) => {
    buckets.debug.push(args.map(String).join(' '));
  };

  return {
    buckets,
    restore() {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      console.info = original.info;
      console.debug = original.debug;
    },
  };
}

async function startTestServer() {
  const { connectMongo } = require('../src/db');
  const { createExpressApp } = require('../src/app');
  const { MONGODB_URI } = require('../src/config');
  const { ensureDemoUsers } = require('../src/services/users');

  await connectMongo(MONGODB_URI);
  await ensureDemoUsers();

  const app = createExpressApp();
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method, path, { headers = {}, body } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  return {
    baseUrl,
    request,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try {
        const mongoose = require('mongoose');
        await mongoose.disconnect();
      } catch (_) {
        /* ignore */
      }
    },
  };
}

module.exports = { captureConsole, startTestServer };
