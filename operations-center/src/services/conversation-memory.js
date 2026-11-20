'use strict';

const fs = require('node:fs');
const os = require('node:os');
const v8 = require('node:v8');

const MiB = 1024 ** 2;
const number = value => /^\d+$/.test(String(value).trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
function statistics(text) {
  return Object.fromEntries(String(text).trim().split('\n').map(line => line.trim().split(/\s+/)).filter(([, value]) => number(value) !== null).map(([key, value]) => [key, Number(value)]));
}

function availableMemory(override, { readFile = file => fs.readFileSync(file, 'utf8'), freeMemory = os.freemem, activeFileCacheCredit = false } = {}) {
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
        const clean = Math.max(0, file - get('shmem') - get(prefix ? 'dirty' : 'file_dirty') - get(prefix ? 'writeback' : 'file_writeback'));
        const inactive = Math.max(0, Math.min(get('inactive_file'), clean));
        // Only the isolated push worker credits a quarter of clean active cache; do not double-count pages.
        const active = activeFileCacheCredit ? Math.max(0, Math.min(get('active_file'), clean - inactive)) : 0;
        reclaimable = Math.floor(inactive / 2 + active / 4);
      } catch { /* Missing statistics must never increase the budget. */ }
      available = Math.min(available, Math.max(0, Math.min(limit, limit - used + reclaimable)));
    } catch { /* The other cgroup version, or the host estimate, may apply. */ }
  }
  return Math.max(0, available);
}

function processingBudgets(override, dependencies = {}) {
  const heap = (dependencies.heapStatistics || v8.getHeapStatistics)();
  return { memory: Math.max(0, availableMemory(override, dependencies) - 32 * MiB),
    heap: Math.max(0, heap.heap_size_limit - heap.used_heap_size - 32 * MiB) };
}

function processingBudget(override, dependencies = {}) {
  const budget = processingBudgets(override, dependencies);
  return Math.min(budget.memory, budget.heap);
}

module.exports = { availableMemory, processingBudget, processingBudgets };
