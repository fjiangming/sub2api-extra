const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encryptJson,
  decryptJson,
  createScryptPasswordHash,
  verifyScryptPassword
} = require('../src/security/encryption');
const { assertSafeUrl, isPrivateIp } = require('../src/security/ssrf-guard');
const { validateJsonPath } = require('../src/adapters/custom');
const { redactText } = require('../src/security/redaction');

test('credential envelope encrypts, authenticates and decrypts JSON', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const input = { apiKey: 'sk-sensitive', nested: { refreshToken: 'refresh' } };
  const encrypted = encryptJson(input, secret);
  assert.equal(encrypted.includes('sk-sensitive'), false);
  assert.deepEqual(decryptJson(encrypted, secret), input);
  assert.throws(() => decryptJson(encrypted, `${secret}x`), /could not be decrypted/);
});

test('local administrator password uses a salted scrypt hash', () => {
  const encoded = createScryptPasswordHash('correct horse battery staple');
  assert.equal(verifyScryptPassword('correct horse battery staple', encoded), true);
  assert.equal(verifyScryptPassword('wrong password', encoded), false);
});

test('SSRF guard allows all private hosts when the host list is empty', async () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('fc00::1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false);

  const allowed = await assertSafeUrl('http://127.0.0.1:8080', {
    allowedHosts: [],
    allowPrivateNetworks: false
  });
  assert.equal(allowed.hostname, '127.0.0.1');
});

test('SSRF guard restricts private hosts when a host list is configured', async () => {
  const allowed = await assertSafeUrl('http://127.0.0.1:8080', {
    allowedHosts: ['127.0.0.1'],
    allowPrivateNetworks: false
  });
  assert.equal(allowed.hostname, '127.0.0.1');
  await assert.rejects(
    assertSafeUrl('http://127.0.0.2:8080', {
      allowedHosts: ['127.0.0.1'],
      allowPrivateNetworks: false
    }),
    (error) => error.code === 'SSRF_BLOCKED'
  );
  await assert.rejects(
    assertSafeUrl('http://[::ffff:127.0.0.1]:8080', {
      allowedHosts: ['127.0.0.1'],
      allowPrivateNetworks: false
    }),
    (error) => error.code === 'SSRF_BLOCKED'
  );
});

test('SSRF guard always blocks known cloud metadata endpoints', async () => {
  await assert.rejects(
    assertSafeUrl('http://169.254.169.254/latest/meta-data', {
      allowedHosts: [],
      allowPrivateNetworks: true
    }),
    (error) => error.code === 'SSRF_BLOCKED'
  );
});

test('custom JSONPath and persisted error text reject executable or sensitive content', () => {
  assert.doesNotThrow(() => validateJsonPath('$.items[*].balance'));
  assert.throws(() => validateJsonPath('$..items[?(@.secret)]'), /blocked expressions/);
  const redacted = redactText('Authorization: Bearer secret-token-value and sk-1234567890abcdef');
  assert.equal(redacted.includes('secret-token-value'), false);
  assert.equal(redacted.includes('1234567890abcdef'), false);
});
