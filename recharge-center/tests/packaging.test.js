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
    '.env.minimal.example',
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

test('minimal automatic-transfer environment contains only deployment-required settings', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, '.env.minimal.example'), 'utf8');
  const assignments = Object.fromEntries(source
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]));
  const required = [
    'NODE_ENV',
    'RECHARGE_CENTER_PAYMENT_MODE',
    'RECHARGE_CENTER_SECRET',
    'RECHARGE_CENTER_PUBLIC_URL',
    'RECHARGE_CENTER_TRUST_PROXY',
    'RECHARGE_CENTER_TRANSFER_QR_SOURCE',
    'RECHARGE_CENTER_QR_PROVISIONER_SECRET',
    'RECHARGE_CENTER_LISTENER_SECRET',
    'RECHARGE_CENTER_LISTENER_COLLECTOR_ID',
    'RECHARGE_CENTER_ALIPAY_RECIPIENT_ID',
    'RECHARGE_CENTER_AUTO_MODE_VERIFIED',
    'SUB2API_BASE_URL',
    'SUB2API_PUBLIC_URL',
    'SUB2API_ADMIN_API_KEY',
    'RECHARGE_CENTER_ALERT_CHANNELS',
    'RECHARGE_CENTER_SMTP_HOST',
    'RECHARGE_CENTER_SMTP_USER',
    'RECHARGE_CENTER_SMTP_PASSWORD',
    'RECHARGE_CENTER_SMTP_FROM',
    'RECHARGE_CENTER_ALERT_EMAIL_TO'
  ];

  assert.deepEqual(Object.keys(assignments), required);
  assert.equal(assignments.NODE_ENV, 'production');
  assert.equal(assignments.RECHARGE_CENTER_PAYMENT_MODE, 'personal_transfer_auto');
  assert.equal(assignments.RECHARGE_CENTER_AUTO_MODE_VERIFIED, 'false');
  assert.equal(assignments.RECHARGE_CENTER_TRANSFER_QR_SOURCE, 'collector');
});
