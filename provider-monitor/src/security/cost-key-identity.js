const crypto = require('node:crypto');

function costKeyIdentity(value) {
  const key = String(value || '').trim().replace(/^Bearer\s+/i, '').replace(/^sk-/, '');
  if (key.length < 16 || /[\s*•…]/u.test(key) || /\.{2,}/.test(key)) return null;
  return crypto.createHash('sha256').update('supplier-group-key-v1\0').update(key).digest('hex');
}

module.exports = { costKeyIdentity };
