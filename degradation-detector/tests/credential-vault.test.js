'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const test = require('node:test');
const { CredentialVault, validateDedicatedKey } = require('../src/credential-vault');
const { testConfig } = require('./helpers');

test('dedicated keys are encrypted at rest and bound to their group', (t) => {
  const config = testConfig(t);
  const vault = new CredentialVault(config);
  const key = 'sk-dedicated-secret-value-1234567890';
  const cipher = vault.encrypt('group-1', key);
  assert.match(cipher, /^v1\./);
  assert.doesNotMatch(cipher, new RegExp(key));
  assert.equal(vault.decrypt('group-1', cipher), key);
  assert.throws(() => vault.decrypt('group-2', cipher), (error) => error.code === 'DETECTION_KEY_UNREADABLE');
  assert.equal(vault.fingerprint(key), vault.fingerprint(key));
  assert.notEqual(vault.fingerprint(key), vault.fingerprint(`${key}-other`));
  assert.doesNotMatch(fs.readFileSync(config.credentialKeyPath, 'utf8'), new RegExp(key));

  const reopened = new CredentialVault(config);
  assert.equal(reopened.decrypt('group-1', cipher), key);
});

test('dedicated key validation rejects masks, placeholders, and control characters', () => {
  assert.throws(() => validateDedicatedKey('short'), /格式无效/);
  assert.throws(() => validateDedicatedKey('sk-masked-***-1234567890'), /掩码值/);
  assert.throws(() => validateDedicatedKey('replace-with-a-real-key'), /占位值/);
  assert.throws(() => validateDedicatedKey('sk-key-with-\nnewline-1234567890'), /格式无效/);
});
