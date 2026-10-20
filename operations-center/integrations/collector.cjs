'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');

function counters(stat, netdev, snmp, diskstats, diskName) {
  const cpu = stat.split('\n').find((line) => /^cpu\s/.test(line))?.trim().split(/\s+/).slice(1, 9).map(Number) || [];
  const network = netdev.split('\n').filter((line) => line.includes(':') && !/^\s*lo:/.test(line))
    .map((line) => line.split(':')[1].trim().split(/\s+/).map(Number));
  const tcpLines = snmp.split('\n').filter((line) => line.startsWith('Tcp:'));
  const tcp = Object.fromEntries((tcpLines[0]?.trim().split(/\s+/).slice(1) || [])
    .map((name, index) => [name, Number(tcpLines[1]?.trim().split(/\s+/)[index + 1])]));
  const disk = diskstats.split('\n').map((line) => line.trim().split(/\s+/)).find((fields) => fields[2] === diskName);
  return { cpu, rx: network.reduce((sum, row) => sum + row[0], 0), tx: network.reduce((sum, row) => sum + row[8], 0),
    drops: network.reduce((sum, row) => sum + row[3] + row[11], 0), retransmits: tcp.RetransSegs,
    diskRead: disk ? Number(disk[5]) * 512 : null, diskWrite: disk ? Number(disk[9]) * 512 : null };
}

function rate(next, previous, seconds) {
  return next != null && previous != null && next >= previous && seconds > 0 ? (next - previous) / seconds : undefined;
}

function resourceSample(current, previous, seconds, meminfo, disk, host, at) {
  const memory = Object.fromEntries(meminfo.split('\n').map((line) => {
    const [name, value] = line.split(':'); return [name, Number.parseInt(value, 10) * 1024];
  }));
  const sample = { type: 'resource', host, at, memoryAvailableBytes: memory.MemAvailable,
    memoryTotalBytes: memory.MemTotal, swapUsedBytes: memory.SwapTotal - memory.SwapFree,
    diskAvailableBytes: disk.bavail * disk.bsize, diskTotalBytes: disk.blocks * disk.bsize, inodeAvailable: disk.ffree };
  if (previous) {
    const delta = current.cpu.map((value, index) => value - previous.cpu[index]);
    const total = delta.reduce((sum, value) => sum + value, 0);
    if (total > 0 && delta.every((value) => value >= 0)) {
      sample.cpuPercent = (total - delta[3] - delta[4] - delta[7]) / total * 100;
      sample.iowaitPercent = delta[4] / total * 100;
      sample.stealPercent = delta[7] / total * 100;
    }
    Object.assign(sample, { networkRxBytesPerSecond: rate(current.rx, previous.rx, seconds),
      networkTxBytesPerSecond: rate(current.tx, previous.tx, seconds),
      networkDropsPerSecond: rate(current.drops, previous.drops, seconds),
      tcpRetransmitsPerSecond: rate(current.retransmits, previous.retransmits, seconds),
      diskReadBytesPerSecond: rate(current.diskRead, previous.diskRead, seconds),
      diskWriteBytesPerSecond: rate(current.diskWrite, previous.diskWrite, seconds) });
  }
  return Object.fromEntries(Object.entries(sample).filter(([, value]) => value !== undefined &&
    (typeof value !== 'number' || Number.isFinite(value) && value >= 0)));
}

function proxySample(row) {
  const duration = (value) => /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) * 1000 : null;
  return { type: 'proxy', requestId: row.request_id, at: new Date(row.at).toISOString(),
    requestTimeMs: duration(row.request_time), upstreamConnectMs: duration(row.upstream_connect_time),
    upstreamHeaderMs: duration(row.upstream_header_time), upstreamResponseMs: duration(row.upstream_response_time),
    requestBytes: Number(row.request_bytes), sentBytes: Number(row.sent_bytes), statusCode: Number(row.status),
    ...(row.cf_ray && /^[a-zA-Z0-9_.:@-]{1,128}$/.test(row.cf_ray) ? { cfRayId: row.cf_ray } : {}) };
}

async function main(env = process.env) {
  if (process.platform !== 'linux') throw new Error('Run the resource collector on the Linux host');
  const endpoint = env.LATENCY_TELEMETRY_URL;
  const token = env.LATENCY_TELEMETRY_TOKEN;
  const host = env.LATENCY_RESOURCE_HOST || os.hostname();
  const diskPath = env.LATENCY_RESOURCE_DISK_PATH || '/www';
  const interval = Math.min(300, Math.max(15, Number(env.LATENCY_RESOURCE_INTERVAL_SECONDS) || 15)) * 1000;
  if (!endpoint || !token || token.length < 32 || !/^[a-zA-Z0-9_.:@-]{1,128}$/.test(host)) throw new Error('Invalid collector configuration');
  let dropped = 0, lastWarning = 0;
  async function send(payload) {
    try {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      await response.arrayBuffer();
      if (!response.ok) throw new Error('export rejected');
    } catch {
      dropped += 1;
      if (Date.now() - lastWarning > 60000) { lastWarning = Date.now(); console.warn(`latency collector export unavailable; dropped=${dropped}`); }
    }
  }
  const queue = [];
  let sending = 0;
  function pump() {
    while (sending < 4 && queue.length) {
      sending += 1;
      send(queue.shift()).finally(() => { sending -= 1; pump(); });
    }
  }
  function enqueue(payload) {
    if (queue.length >= 256) { dropped += 1; return; }
    queue.push(payload); pump();
  }
  let previous = null, previousAt = null, stopped = false;
  process.on('SIGTERM', () => { stopped = true; }); process.on('SIGINT', () => { stopped = true; });
  async function sample() {
    const at = Date.now();
    const [stat, netdev, snmp, diskstats, memory, disk] = await Promise.all([
      fs.readFile('/proc/stat', 'utf8'), fs.readFile('/proc/net/dev', 'utf8'), fs.readFile('/proc/net/snmp', 'utf8'),
      fs.readFile('/proc/diskstats', 'utf8'), fs.readFile('/proc/meminfo', 'utf8'), fs.statfs(diskPath)
    ]);
    const current = counters(stat, netdev, snmp, diskstats, env.LATENCY_RESOURCE_DISK || 'vdb');
    enqueue(resourceSample(current, previous, (at - previousAt) / 1000, memory, disk, host, new Date(at).toISOString()));
    previous = current; previousAt = at;
  }
  let offset = null, inode = null, remainder = '', droppingLine = false;
  async function tail() {
    if (!env.LATENCY_NGINX_LOG) return;
    const handle = await fs.open(env.LATENCY_NGINX_LOG, 'r');
    try {
      const stat = await handle.stat();
      if (offset == null) offset = stat.size;
      else if (inode !== stat.ino || stat.size < offset) { offset = 0; remainder = ''; droppingLine = false; }
      inode = stat.ino;
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;
      const lines = (remainder + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
      remainder = lines.pop();
      for (const line of lines.slice(0, 200)) {
        if (droppingLine) { droppingLine = false; continue; }
        if (line.length > 32768) { dropped += 1; continue; }
        try { enqueue(proxySample(JSON.parse(line))); } catch { dropped += 1; }
      }
      dropped += Math.max(0, lines.length - 200);
      if (remainder.length > 32768) { remainder = ''; droppingLine = true; dropped += 1; }
    } finally { await handle.close(); }
  }
  let lastSample = 0;
  while (!stopped) {
    if (Date.now() - lastSample >= interval) { lastSample = Date.now(); await sample().catch(() => { console.warn('latency resource sample unavailable'); }); }
    await tail().catch(() => { if (Date.now() - lastWarning > 60000) { lastWarning = Date.now(); console.warn('latency nginx log unavailable'); } });
    if (env.LATENCY_COLLECTOR_ONCE === 'true') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { counters, resourceSample, proxySample };
