'use strict';

const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const directory of ['src', 'public', 'scripts', 'tests']) {
  for (const file of readdirSync(path.join(__dirname, '..', directory), { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(__dirname, '..', directory, file.name)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript syntax checks passed');
