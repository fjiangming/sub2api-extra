'use strict';

const fs = require('node:fs');
const os = require('node:os');
const v8 = require('node:v8');

const MiB = 1024 ** 2;
const number = value => /^\d+$/.test(String(value).trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
function statistics(text) {
  return Object.fromEntries(String(text).trim().split('\n').map(line => line.trim().split(/\s+/)).filter(([, value]) => number(value) !== null).map(([key, value]) => [key, Number(value)]));
}

function availableMemory(override, { readFile = file => fs.readFileSync(file, 'utf8'), freeMemory = os.freemem } = {}) {
  if (Number.isSafeInteger(override) && override >= 0) return override;
  let available = freeMemory();
  try {
    const host = /^MemAvailable:\s+(\d+) kB$/m.exec(readFile('/proc/meminfo'));
    if (host && number(host[1]) !== null) available = Math.max(available, Number(host[1]) * 1024);
  } catch { /* Non-Linux hosts use the host free-memory estimate. */ }
  for (const [base, limitFile, usageFile, prefix] of [
    ['/sys/fs/cgroup/', 'memory.max', 'memory.current', ''],
    ['/sys/fs/cgroup/memory/', 'memory.limit_in_bytes', 'memory.usage_in_bytes', 'total_']
  ]) {
    try {
      const limit = number(readFile(base + limitFile)), used = number(readFile(base + usageFile));
      if (limit === null || used === null) continue;
      let reclaimable = 0;
      try {
        const stat = statistics(readFile(base + 'memory.stat'));
        const get = key => stat[prefix + key] ?? stat[key] ?? 0;
        const file = get(prefix ? 'cache' : 'file');
        // Credit only half of clean inactive file cache. Anonymous, shared and dirty pages remain charged.
        reclaimable = Math.floor(Math.max(0, Math.min(get('inactive_file'), file - get('shmem') - get(prefix ? 'dirty' : 'file_dirty') - get(prefix ? 'writeback' : 'file_writeback'))) / 2);
      } catch { /* Missing statistics must never increase the budget. */ }
      available = Math.min(available, Math.max(0, Math.min(limit, limit - used + reclaimable)));
    } catch { /* The other cgroup version, or the host estimate, may apply. */ }
  }
  return Math.max(0, available);
}

function processingBudget(override, dependencies = {}) {
  const heap = (dependencies.heapStatistics || v8.getHeapStatistics)();
  return Math.max(0, Math.min(availableMemory(override, dependencies) - 32 * MiB, heap.heap_size_limit - heap.used_heap_size - 32 * MiB));
}

module.exports = { availableMemory, processingBudget };
