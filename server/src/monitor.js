'use strict';
/**
 * Server monitoring — lightweight sampling for the owner dashboard.
 *
 * CPU is derived from os.cpus() deltas between samples (no native deps).
 * Network throughput is read from /proc/net/dev on Linux (the host case),
 * with a graceful zero on platforms without it. Disk usage covers the data
 * directory's filesystem via statfs. Live counts come from the callers.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

let lastCpu = sampleCpu();
let lastNet = sampleNet();
let lastNetAt = Date.now();

function sampleCpu() {
  let idle = 0, total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function cpuPercent() {
  const now = sampleCpu();
  const idleDelta = now.idle - lastCpu.idle;
  const totalDelta = now.total - lastCpu.total;
  lastCpu = now;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

/** Sum rx/tx bytes across real interfaces from /proc/net/dev (Linux). */
function sampleNet() {
  try {
    const data = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of data.split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(.+)$/);
      if (!m) continue;
      const iface = m[1].trim();
      if (iface === 'lo') continue;
      const cols = m[2].trim().split(/\s+/).map(Number);
      rx += cols[0] || 0;
      tx += cols[8] || 0;
    }
    return { rx, tx };
  } catch {
    return { rx: 0, tx: 0 };
  }
}

function netThroughput() {
  const now = sampleNet();
  const at = Date.now();
  const secs = Math.max(0.001, (at - lastNetAt) / 1000);
  const rxBps = Math.max(0, (now.rx - lastNet.rx) / secs);
  const txBps = Math.max(0, (now.tx - lastNet.tx) / secs);
  lastNet = now;
  lastNetAt = at;
  return { rxBps: Math.round(rxBps), txBps: Math.round(txBps) };
}

/** Filesystem usage for the partition holding `dir`. */
function diskUsage(dir) {
  try {
    const st = fs.statfsSync(dir);
    const total = st.blocks * st.bsize;
    const free = st.bfree * st.bsize;
    return { total, used: total - free, free };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}

/**
 * Full snapshot. Caller supplies live Hearth counts and the storage
 * breakdown (db already knows those) plus the data dir for disk stats.
 */
function snapshot({ dataDir, live = {}, storage = {} }) {
  const mem = { total: os.totalmem(), free: os.freemem() };
  mem.used = mem.total - mem.free;
  const load = os.loadavg();
  return {
    at: Date.now(),
    host: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cores: os.cpus().length,
      uptimeSec: Math.round(os.uptime()),
      procUptimeSec: Math.round(process.uptime())
    },
    cpu: { percent: cpuPercent(), load1: load[0], load5: load[1], load15: load[2] },
    memory: mem,
    process: {
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed
    },
    network: netThroughput(),
    disk: diskUsage(dataDir),
    storage,   // { chatBytes, emojiBytes, previewBytes }
    live       // { users, online, voice, rooms, producers, jukeboxes }
  };
}

module.exports = { snapshot };
