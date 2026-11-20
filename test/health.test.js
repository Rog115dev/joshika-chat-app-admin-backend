const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatUptime,
  formatGb,
  mongoStateLabel,
  formatHostStatusLines,
  hostStats,
  primeCpuSample,
} = require('../src/services/health');

describe('host status formatting', () => {
  it('formatUptime is human readable', () => {
    assert.equal(formatUptime(5), '5s');
    assert.equal(formatUptime(65), '1m 5s');
    assert.equal(formatUptime(3661), '1h 1m 1s');
  });

  it('formatGb shows GB values', () => {
    assert.equal(formatGb(32 * 1024 * 1024 * 1024), '32 GB');
    assert.match(formatGb(3.5 * 1024 * 1024 * 1024), /3\.5 GB/);
  });

  it('mongoStateLabel maps readyState', () => {
    assert.equal(mongoStateLabel(0), 'disconnected');
    assert.equal(mongoStateLabel(1), 'connected');
    assert.equal(mongoStateLabel(2), 'connecting');
  });

  it('formatHostStatusLines includes system RAM and process/CPU', () => {
    const lines = formatHostStatusLines({
      uptimeSec: 61,
      memory: {
        rssMB: 103.4,
        heapUsedMB: 22.8,
        heapTotalMB: 55.3,
        externalMB: 1,
        processPercentOfSystem: 0.3,
        system: {
          totalBytes: 32 * 1024 * 1024 * 1024,
          usedBytes: 3.5 * 1024 * 1024 * 1024,
          freeBytes: 28.5 * 1024 * 1024 * 1024,
          usedPercent: 10.9,
        },
      },
      cpu: {
        loadAvg: [0.5, 0.4, 0.3],
        cores: 16,
        processPercent: 2.1,
        systemPercent: 14.5,
        systemLoadPercent: 14.5,
      },
      mongoReadyState: 1,
    });
    assert.ok(lines.some((l) => l.startsWith('Mongo') && l.includes('connected')));
    assert.ok(lines.some((l) => l.startsWith('Uptime') && l.includes('1m 1s')));
    assert.ok(
      lines.some(
        (l) =>
          l.includes('System RAM') &&
          l.includes('3.5 GB') &&
          l.includes('32 GB') &&
          l.includes('% used'),
      ),
    );
    assert.ok(
      lines.some(
        (l) =>
          l.includes('Process') &&
          l.includes('103.4 MB rss') &&
          l.includes('0.3% of system'),
      ),
    );
    assert.ok(
      lines.some(
        (l) =>
          l.includes('CPU') &&
          l.includes('process 2.1%') &&
          l.includes('system 14.5%') &&
          l.includes('cores 16'),
      ),
    );
  });

  it('primeCpuSample yields real CPU percents on Windows-capable APIs', async () => {
    const sample = await primeCpuSample(80);
    assert.ok(typeof sample.processPercent === 'number');
    assert.ok(typeof sample.systemPercent === 'number');
    assert.ok(sample.processPercent >= 0 && sample.processPercent <= 100);
    assert.ok(sample.systemPercent >= 0 && sample.systemPercent <= 100);

    const s = hostStats();
    assert.ok(typeof s.memory.system.usedPercent === 'number');
    assert.ok(
      typeof s.cpu.systemPercent === 'number' ||
        typeof s.cpu.systemLoadPercent === 'number',
    );
  });
});
