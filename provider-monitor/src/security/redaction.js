const SENSITIVE_KEY = /password|secret|token|api[_-]?key|authorization|cookie|credential/i;

function maskValue(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '***';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function redact(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? maskValue(item) : redact(item, seen)
    ])
  );
}

function maskKey(key) {
  return maskValue(key);
}

function redactText(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|sess|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '$1-[REDACTED]')
    .replace(/([?&](?:token|key|api_key|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:password|secret|token|api[_-]?key|authorization)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');
}

module.exports = {
  redact,
  redactText,
  maskKey,
  maskValue
};
