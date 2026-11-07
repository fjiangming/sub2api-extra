'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let count = 0;
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) check(filename);
    else if (/\.(?:js|cjs)$/.test(entry.name)) {
      execFileSync(process.execPath, ['--check', filename], { stdio: 'pipe' });
      count++;
    }
  }
}
for (const directory of ['src', 'public', 'admin', 'tests', 'scripts']) check(path.join(__dirname, '..', directory));
console.log(`Syntax checked ${count} JavaScript files.`);
