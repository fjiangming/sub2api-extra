'use strict';

function dayAt(at, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function objectKey(prefix, day, model, at, id) {
  const name = model.normalize('NFKC').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown-model';
  const stamp = new Date(at).toISOString().replace(/[-:.]/g, '');
  return [prefix, day, `${name}-${day}-${stamp}-${id.slice(0, 16)}.jsonl`].filter(Boolean).join('/');
}

// Encode one JSON value in bounded pieces; a JSONL record always ends with one LF.
function* jsonChunks(value) {
  if (typeof value === 'string' && value.length > 16384) {
    yield '"';
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 16384, value.length);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
      yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
      offset = end;
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index++) {
      if (index) yield ',';
      yield* jsonChunks(value[index] ?? null);
    }
    yield ']';
  } else if (value && typeof value === 'object') {
    yield '{'; let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!first) yield ',';
      first = false; yield JSON.stringify(key); yield ':'; yield* jsonChunks(item);
    }
    yield '}';
  } else yield JSON.stringify(value);
}

function* jsonlChunks(envelope) { yield* jsonChunks(envelope); yield '\n'; }
function jsonlBytes(envelope) {
  let bytes = 0;
  for (const chunk of jsonlChunks(envelope)) bytes += Buffer.byteLength(chunk);
  return bytes;
}

module.exports = { dayAt, objectKey, jsonChunks, jsonlChunks, jsonlBytes };
