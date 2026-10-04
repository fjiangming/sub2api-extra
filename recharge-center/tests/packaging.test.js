'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('Docker build context excludes runtime payment secrets and ledger data', () => {
  const dockerignore = fs.readFileSync(path.resolve(__dirname, '..', '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(dockerignore.includes('secrets'));
  assert.ok(dockerignore.includes('data'));
  assert.ok(dockerignore.includes('.env'));
});

test('npm package uses an explicit allowlist without runtime payment data', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.files, [
    'src/',
    'tools/',
    'public/',
    'docs/',
    '.env.example',
    'compose.yaml',
    'Dockerfile'
  ]);
  assert.ok(manifest.files.every((entry) => !/(?:^|\/)(?:data|data-preview|secrets|tests)(?:\/|$)|^\.env$/i.test(entry)));
});

test('every example environment setting has purpose and source documentation', () => {
  const root = path.resolve(__dirname, '..');
  const envLines = fs.readFileSync(path.join(root, '.env.example'), 'utf8').split(/\r?\n/);
  const assignments = new Set();

  envLines.forEach((line, index) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!match) return;
    assignments.add(match[1]);
    assert.match(
      envLines[index - 1] || '',
      /^# 作用：.+来源：.+/,
      `${match[1]} 前必须紧邻包含“作用”和“来源”的中文注释`
    );
  });

  const configSource = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');
  const schemaBody = configSource.match(/const schema = z\.object\(\{([\s\S]*?)\n\}\)\.superRefine/);
  assert.ok(schemaBody, '应能读取运行配置 schema');
  const runtimeNames = [...schemaBody[1].matchAll(/^  ([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]);
  const composeNames = [
    'RECHARGE_CENTER_IMAGE',
    'RECHARGE_CENTER_CONTAINER_NAME',
    'RECHARGE_CENTER_RESTART_POLICY',
    'RECHARGE_CENTER_PORT',
    'RECHARGE_CENTER_DATA_VOLUME',
    'NPM_REGISTRY'
  ];

  for (const name of [...runtimeNames, ...composeNames]) {
    assert.ok(assignments.has(name), `.env.example 缺少 ${name}`);
  }
});
