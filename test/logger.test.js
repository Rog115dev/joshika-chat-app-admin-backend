const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { logger, LEVELS } = require('../src/logger');
const { captureConsole } = require('./helpers');

describe('logger modes', () => {
  it('exposes level constants', () => {
    assert.equal(LEVELS.debug, 10);
    assert.equal(LEVELS.info, 20);
    assert.equal(LEVELS.warn, 30);
    assert.equal(LEVELS.error, 40);
  });

  it('debug writes to console.log with DEBUG tag', () => {
    const cap = captureConsole();
    try {
      logger.debug('debug-mode-message', { a: 1 });
      assert.ok(cap.buckets.log.some((l) => l.includes('DEBUG')));
      assert.ok(cap.buckets.log.some((l) => l.includes('debug-mode-message')));
      assert.ok(cap.buckets.log.some((l) => l.includes('a=1')));
    } finally {
      cap.restore();
    }
  });

  it('info writes to console.log with INFO tag', () => {
    const cap = captureConsole();
    try {
      logger.info('info-mode-message', { ok: true });
      assert.ok(cap.buckets.log.some((l) => l.includes('INFO')));
      assert.ok(cap.buckets.log.some((l) => l.includes('info-mode-message')));
      assert.ok(cap.buckets.log.some((l) => l.includes('ok=true')));
    } finally {
      cap.restore();
    }
  });

  it('warn writes to console.warn with WARN tag', () => {
    const cap = captureConsole();
    try {
      logger.warn('warn-mode-message', { code: 'X' });
      assert.ok(cap.buckets.warn.some((l) => l.includes('WARN')));
      assert.ok(cap.buckets.warn.some((l) => l.includes('warn-mode-message')));
      assert.ok(cap.buckets.warn.some((l) => l.includes('code=X')));
    } finally {
      cap.restore();
    }
  });

  it('error writes to console.error with ERROR tag and stack', () => {
    const cap = captureConsole();
    try {
      const err = new Error('boom');
      logger.error('error-mode-message', { err });
      assert.ok(cap.buckets.error.some((l) => l.includes('ERROR')));
      assert.ok(cap.buckets.error.some((l) => l.includes('error-mode-message')));
      assert.ok(
        cap.buckets.error.some(
          (l) => l.includes('boom') || l.includes('Error: boom'),
        ),
      );
    } finally {
      cap.restore();
    }
  });

  it('metric uses info channel', () => {
    const cap = captureConsole();
    try {
      logger.metric('host', { rssMB: 12.3 });
      assert.ok(cap.buckets.log.some((l) => l.includes('INFO')));
      assert.ok(cap.buckets.log.some((l) => l.includes('host')));
      assert.ok(cap.buckets.log.some((l) => l.includes('rssMB=12.3')));
    } finally {
      cap.restore();
    }
  });

  it('status prints a readable multi-line block', () => {
    const cap = captureConsole();
    try {
      logger.status('Host status', [
        'Mongo     connected',
        'Uptime    1m 5s',
        'Memory    heap 21 / 22.8 MB   rss 87.5 MB',
        'CPU       load 0.00  0.00  0.00   cores 16',
      ]);
      const joined = cap.buckets.log.join('\n');
      assert.ok(joined.includes('STATUS'));
      assert.ok(joined.includes('Host status'));
      assert.ok(joined.includes('Mongo     connected'));
      assert.ok(joined.includes('Uptime    1m 5s'));
      assert.ok(joined.includes('Memory'));
      assert.ok(joined.includes('CPU'));
    } finally {
      cap.restore();
    }
  });

  it('requestError logs method and path', () => {
    const cap = captureConsole();
    try {
      logger.requestError(
        { method: 'GET', originalUrl: '/health' },
        new Error('failed'),
        { status: 500 },
      );
      const joined = cap.buckets.error.join('\n');
      assert.ok(joined.includes('request failed'));
      assert.ok(joined.includes('method=GET'));
      assert.ok(joined.includes('path=/health'));
      assert.ok(joined.includes('status=500'));
    } finally {
      cap.restore();
    }
  });
});
