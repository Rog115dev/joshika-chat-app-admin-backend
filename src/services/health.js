const os = require('os');
const mongoose = require('mongoose');
const { User, Verification } = require('../models');

/** @type {{ usage: NodeJS.CpuUsage, atMs: number } | null} */
let lastProcSample = null;
/** @type {{ idle: number, total: number } | null} */
let lastSysSample = null;
/** Last successfully computed percentages (reuse if sample window is too short). */
let lastCpuPercents = { processPercent: null, systemPercent: null };

function bytesToMb(n) {
  return Math.round((Number(n) || 0) / (1024 * 1024) * 10) / 10;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/** Format bytes as GB with one decimal, e.g. 3.5 GB */
function formatGb(bytes) {
  const gb = Number(bytes) / (1024 * 1024 * 1024);
  return `${round1(gb)} GB`;
}

function formatUptime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m ${r}s`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function mongoStateLabel(readyState) {
  return (
    ['disconnected', 'connected', 'connecting', 'disconnecting'][readyState] ||
    String(readyState)
  );
}

function readSystemCpuTimes() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times || {};
    const slice =
      (t.user || 0) +
      (t.nice || 0) +
      (t.sys || 0) +
      (t.irq || 0) +
      (t.idle || 0);
    idle += t.idle || 0;
    total += slice;
  }
  return { idle, total };
}

/**
 * Sample process + system CPU %.
 * System % uses os.cpus() time deltas (works on Windows; loadavg does not).
 */
function sampleCpuPercents() {
  const nowProc = process.cpuUsage();
  const nowMs = Date.now();
  const nowSys = readSystemCpuTimes();

  let processPercent = lastCpuPercents.processPercent;
  let systemPercent = lastCpuPercents.systemPercent;

  if (lastProcSample) {
    const cores = Math.max(1, (os.cpus() || []).length);
    const elapsedUs = Math.max(1, (nowMs - lastProcSample.atMs) * 1000);
    const usedUs = Math.max(
      0,
      nowProc.user -
        lastProcSample.usage.user +
        (nowProc.system - lastProcSample.usage.system),
    );
    // % of whole machine (same 0–100 scale as system); raw one-core % / cores
    processPercent = round1(
      Math.min(100, Math.max(0, (usedUs / elapsedUs / cores) * 100)),
    );
  }

  if (lastSysSample && nowSys.total > lastSysSample.total) {
    const totalDelta = nowSys.total - lastSysSample.total;
    const idleDelta = Math.max(0, nowSys.idle - lastSysSample.idle);
    systemPercent = round1(
      Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)),
    );
  }

  lastProcSample = { usage: nowProc, atMs: nowMs };
  lastSysSample = nowSys;
  lastCpuPercents = { processPercent, systemPercent };
  return { processPercent, systemPercent };
}

/** Take two samples so the first status log has real CPU numbers. */
async function primeCpuSample(waitMs = 250) {
  sampleCpuPercents();
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return sampleCpuPercents();
}

function hostStats() {
  const mem = process.memoryUsage();
  const load = os.loadavg();
  const cores = os.cpus()?.length || 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const usedPercent = totalMem > 0 ? round1((usedMem / totalMem) * 100) : 0;
  const { processPercent, systemPercent } = sampleCpuPercents();

  return {
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rssMB: bytesToMb(mem.rss),
      heapUsedMB: bytesToMb(mem.heapUsed),
      heapTotalMB: bytesToMb(mem.heapTotal),
      externalMB: bytesToMb(mem.external),
      processRssBytes: mem.rss,
      processPercentOfSystem:
        totalMem > 0 ? round1((mem.rss / totalMem) * 100) : 0,
      system: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usedBytes: usedMem,
        usedPercent,
        totalGB: round1(totalMem / (1024 * 1024 * 1024)),
        usedGB: round1(usedMem / (1024 * 1024 * 1024)),
        freeGB: round1(freeMem / (1024 * 1024 * 1024)),
      },
    },
    cpu: {
      loadAvg: load.map((n) => Math.round(n * 100) / 100),
      cores,
      processPercent,
      systemPercent,
      // keep old name as alias for API consumers
      systemLoadPercent: systemPercent,
    },
    mongoReadyState: mongoose.connection.readyState,
  };
}

/** Human-readable lines for console / health status. */
function formatHostStatusLines(stats = hostStats()) {
  const mongo = mongoStateLabel(stats.mongoReadyState);
  const sys = stats.memory.system || {};
  const procPct =
    stats.cpu.processPercent == null
      ? 'n/a'
      : `${stats.cpu.processPercent}%`;
  const sysPct =
    stats.cpu.systemPercent == null && stats.cpu.systemLoadPercent == null
      ? 'n/a'
      : `${stats.cpu.systemPercent ?? stats.cpu.systemLoadPercent}%`;

  return [
    `Mongo      ${mongo}`,
    `Uptime     ${formatUptime(stats.uptimeSec)}`,
    `System RAM ${formatGb(sys.usedBytes)} / ${formatGb(sys.totalBytes)}   ${sys.usedPercent}% used`,
    `Process    ${stats.memory.rssMB} MB rss (${stats.memory.processPercentOfSystem}% of system)   heap ${stats.memory.heapUsedMB} / ${stats.memory.heapTotalMB} MB`,
    `CPU        process ${procPct}   system ${sysPct}   cores ${stats.cpu.cores}`,
  ];
}

async function collectHealth() {
  const stats = hostStats();
  let mongoOk = false;
  let pingMs = null;
  let users = null;
  let verifications = null;

  try {
    const t0 = Date.now();
    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      await mongoose.connection.db.admin().ping();
      pingMs = Date.now() - t0;
      mongoOk = true;
    }
  } catch {
    mongoOk = false;
  }

  if (mongoOk) {
    try {
      [users, verifications] = await Promise.all([
        User.countDocuments(),
        Verification.countDocuments(),
      ]);
    } catch {
      mongoOk = false;
    }
  }

  const status = formatHostStatusLines(stats);

  return {
    ok: mongoOk,
    mongo: mongoOk,
    mongoDetail: {
      ok: mongoOk,
      pingMs,
      readyState: stats.mongoReadyState,
      state: mongoStateLabel(stats.mongoReadyState),
    },
    users,
    verifications,
    selfieMedia: true,
    build: 'mongo-v1',
    uptimeSec: stats.uptimeSec,
    uptime: formatUptime(stats.uptimeSec),
    memory: stats.memory,
    cpu: stats.cpu,
    status,
    statusText: status.join('\n'),
  };
}

module.exports = {
  hostStats,
  collectHealth,
  bytesToMb,
  formatGb,
  formatUptime,
  mongoStateLabel,
  formatHostStatusLines,
  primeCpuSample,
  sampleCpuPercents,
};
