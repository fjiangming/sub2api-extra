'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function files(root) { return fs.readdirSync(root,{ withFileTypes:true }).flatMap(item => item.isDirectory() ? files(path.join(root,item.name)) : [path.join(root,item.name)]); }
for (const file of ['src','scripts','tests'].flatMap(dir => files(path.join(__dirname,'..',dir))).filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath,['--check',file],{ stdio:'inherit' });
  if (result.status!==0) process.exit(result.status || 1);
}
