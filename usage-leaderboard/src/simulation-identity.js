'use strict';

function createSimulationNames(random, reservedNames = new Set()) {
  const pools = ['qq.com', 'gmail.com', '163.com'].map((domain) => {
    const prefixes = domain === 'qq.com'
      ? Array.from({ length: 90 }, (_, index) => String(index + 10))
      : Array.from({ length: 676 }, (_, index) => `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`);
    return prefixes.map((prefix) => `${prefix}***@${domain}`).filter((name) => !reservedNames.has(name));
  }).filter((pool) => pool.length);
  const names = [];
  while (pools.length) {
    const index = Math.floor(random() * pools.length);
    const pool = pools[index];
    names.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
    if (!pool.length) pools.splice(index, 1);
  }
  return names;
}

module.exports = { createSimulationNames };
