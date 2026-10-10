'use strict';

const crypto = require('crypto');

function publicVisualSettings(visual) {
  if (!visual) return undefined;
  const { api_key: _key, clear_api_key: _clear, key_cipher: _cipher,
    key_context: _context, key_fingerprint: _fingerprint, ...settings } = visual;
  return { ...settings, api_key_configured: Boolean(visual.key_cipher) };
}

function snapshotValidation(validation) {
  if (!validation?.visual) return validation;
  const { visual, ...policy } = validation;
  if (!visual.enabled) return policy;
  const { api_key: _key, clear_api_key: _clear, api_key_configured: _configured,
    key_cipher: _cipher, key_context: _context, ...settings } = visual;
  return { ...policy, visual: settings };
}

function visualEndpoint(visual) {
  return new URL(visual.api_url).href.replace(/\/$/, '');
}

function storeVisualTest(test, vault, scope, previousTest, inheritedTest) {
  if (!test?.validation?.visual) return test;
  const submitted = test.validation.visual;
  const visual = { ...publicVisualSettings(submitted), api_url: visualEndpoint(submitted) };
  delete visual.api_key_configured;
  const key = String(submitted.api_key || '').trim();
  const previous = [previousTest?.validation?.visual, inheritedTest?.validation?.visual]
    .find((candidate) => candidate?.key_cipher && candidate.protocol === submitted.protocol
      && visualEndpoint(candidate) === visual.api_url);
  if (key || (previous && !submitted.clear_api_key)) {
    const value = key || vault.decrypt(previous.key_context, previous.key_cipher);
    const context = `visual-${crypto.createHash('sha256').update(scope).digest('hex')}`;
    visual.key_context = context;
    visual.key_cipher = vault.encrypt(context, value);
    visual.key_fingerprint = vault.fingerprint(value);
  }
  return { ...test, validation: { ...test.validation, visual } };
}

module.exports = { publicVisualSettings, snapshotValidation, storeVisualTest };
