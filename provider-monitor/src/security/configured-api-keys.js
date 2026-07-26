const crypto = require('crypto');

const LEGACY_CONFIGURED_API_KEY_ID = 'configured-api-key';

function cleanApiKey(value) {
  return String(value || '').trim().replace(/^Bearer\s+/i, '');
}

function cleanEntryId(value) {
  return String(value || '').trim().slice(0, 200);
}

function cleanEntryName(value) {
  return String(value || '').trim().slice(0, 120);
}

function rawApiKeyEntries(credentials = {}) {
  const entries = [];
  if (Array.isArray(credentials.apiKeys)) entries.push(...credentials.apiKeys);
  const legacyKey = cleanApiKey(
    credentials.apiKey || credentials.bearerToken || credentials.token
  );
  if (legacyKey) {
    entries.unshift({
      id: LEGACY_CONFIGURED_API_KEY_ID,
      name: 'API Key',
      key: legacyKey
    });
  }
  return entries;
}

function normalizeConfiguredApiKeys(credentials = {}, options = {}) {
  const result = [];
  const ids = new Set();
  const values = new Set();
  for (const rawEntry of rawApiKeyEntries(credentials)) {
    const entry = typeof rawEntry === 'string' ? { key: rawEntry } : rawEntry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const key = cleanApiKey(entry.key ?? entry.apiKey ?? entry.value ?? entry.token);
    if (!key || values.has(key)) continue;
    let id = cleanEntryId(entry.id ?? entry.keyId ?? entry.remoteId);
    if (!id || ids.has(id)) id = crypto.randomUUID();
    const name = cleanEntryName(entry.name ?? entry.label) ||
      `${options.defaultName || 'API Key'} ${result.length + 1}`;
    ids.add(id);
    values.add(key);
    result.push({ id, name, key });
  }
  return result;
}

function mergeConfiguredApiKeyCredentials(existing = {}, incoming = {}) {
  if (!Object.prototype.hasOwnProperty.call(incoming, 'apiKeys')) {
    const merged = { ...existing, ...incoming };
    if (Object.prototype.hasOwnProperty.call(incoming, 'apiKey')) delete merged.apiKeys;
    return merged;
  }

  const existingById = new Map(
    normalizeConfiguredApiKeys(existing).map((entry) => [entry.id, entry])
  );
  const candidates = [];
  for (const rawEntry of Array.isArray(incoming.apiKeys) ? incoming.apiKeys : []) {
    const entry = typeof rawEntry === 'string' ? { key: rawEntry } : rawEntry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = cleanEntryId(entry.id ?? entry.keyId ?? entry.remoteId);
    const stored = id ? existingById.get(id) : null;
    const key = cleanApiKey(entry.key ?? entry.apiKey ?? entry.value ?? entry.token) || stored?.key || '';
    candidates.push({
      id: id || stored?.id || '',
      name: cleanEntryName(entry.name ?? entry.label) || stored?.name || '',
      key
    });
  }

  const normalized = normalizeConfiguredApiKeys({ apiKeys: candidates });
  const merged = { ...existing, ...incoming, apiKeys: normalized };
  delete merged.apiKey;
  delete merged.bearerToken;
  delete merged.token;
  return merged;
}

function configuredApiKeyMetadata(credentials = {}, maskValue = (value) => value) {
  return normalizeConfiguredApiKeys(credentials).map((entry) => ({
    id: entry.id,
    name: entry.name,
    masked: maskValue(entry.key)
  }));
}

function configuredApiKeyById(credentials = {}, id) {
  const entries = normalizeConfiguredApiKeys(credentials);
  return entries.find((entry) => entry.id === String(id || '')) || null;
}

module.exports = {
  LEGACY_CONFIGURED_API_KEY_ID,
  cleanApiKey,
  configuredApiKeyById,
  configuredApiKeyMetadata,
  mergeConfiguredApiKeyCredentials,
  normalizeConfiguredApiKeys
};
