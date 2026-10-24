'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { AppError } = require('../errors');

const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_EVENTS = 600000;
const MAX_LINE = 65536;
const millis = value => value == null ? NaN : new Date(value).getTime();
const positive = value => (typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value)) &&
  Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
const text = value => typeof value === 'string' && value.length <= 200 ? value : undefined;
const limited = () => new AppError('LOG_SOURCE_TRUNCATED', '文件日志超过读取上限，请缩小只读日志目录，不能使用截断证据匹配', { status: 409 });

function sanitizeLogEvent(value, timestamp) {
  if (!value || typeof value !== 'object') return null;
  const event = { component: text(value.component), request_id: text(value.request_id),
    client_request_id: text(value.client_request_id), ts: text(value.ts || value.time || timestamp),
    completed_at: text(value.completed_at), model: text(value.model),
    ...(typeof value.stream === 'boolean' ? { stream: value.stream } : {}) };
  if (!event.request_id || !Number.isFinite(millis(event.ts))) return null;
  for (const key of ['user_id', 'api_key_id', 'group_id', 'selected_account_id', 'account_id', 'status_code']) {
    const number = positive(value[key]); if (number) event[key] = number;
  }
  if (Number.isFinite(value.latency_ms) && value.latency_ms >= 0 && value.latency_ms <= 4 * 3600000) event.latency_ms = value.latency_ms;
  return event;
}

class BillingImportLogs {
  constructor(directory) { this.directory = directory; }
  async load({ from, to }) {
    if (!this.directory) return { events: [], diagnostics: { status: 'not_configured' } };
    const directory = await fs.promises.realpath(this.directory);
    const names = (await fs.promises.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^sub2api(?:[-.][\w.-]+)?\.log(?:\.gz)?$/.test(entry.name)).map(entry => entry.name).sort();
    if (names.length > 128) throw limited();
    const events = []; let bytes = 0, invalidLines = 0, first = Infinity, last = -Infinity;
    for (const name of names) {
      const handle = await fs.promises.open(path.join(directory, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let stream, raw;
      try {
        if (!(await handle.stat()).isFile()) throw limited();
        raw = handle.createReadStream({ autoClose: false });
        stream = name.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
        if (stream !== raw) raw.on('error', error => stream.destroy(error));
        stream.setEncoding('utf8'); let buffer = '';
        const consume = line => {
          if (!line.trim()) return;
          const start = line.startsWith('{') ? 0 : line.lastIndexOf('\t{') + 1;
          if (start < 0 || line[start] !== '{') { invalidLines++; return; }
          let value;
          try { value = JSON.parse(line.slice(start)); } catch { invalidLines++; return; }
          const event = sanitizeLogEvent(value, line.split('\t', 1)[0]);
          if (!event) { invalidLines++; return; }
          const at = millis(event.ts); first = Math.min(first, at); last = Math.max(last, at);
          if (at >= millis(from) && at <= millis(to)) {
            events.push(event); if (events.length > MAX_EVENTS) throw limited();
          }
        };
        for await (const chunk of stream) {
          bytes += Buffer.byteLength(chunk); if (bytes > MAX_BYTES) throw limited();
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            if (end > MAX_LINE) throw limited();
            consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          }
          if (buffer.length > MAX_LINE) throw limited();
        }
        if (buffer) consume(buffer);
      } finally { stream?.destroy(); raw?.destroy(); await handle.close(); }
    }
    return { events, diagnostics: { status: names.length ? 'read' : 'empty', files: names.length, bytes, invalidLines,
      first: Number.isFinite(first) ? new Date(first).toISOString() : null, last: Number.isFinite(last) ? new Date(last).toISOString() : null,
      coverageComplete: false } };
  }
}

function buildLogCandidates(events, { from, to, accounts }) {
  const requests = new Map(), allowed = new Set(accounts.map(String));
  for (const input of events) {
    const event = sanitizeLogEvent(input);
    if (!event || millis(event.ts) < millis(from) || millis(event.ts) > millis(to)) continue;
    const list = requests.get(event.request_id) || [];
    if (list.length < 100) list.push(event);
    else throw limited();
    requests.set(event.request_id, list);
  }
  const candidates = [];
  for (const [requestId, list] of requests) {
    const access = list.filter(event => event.component === 'http.access');
    const selections = list.filter(event => event.selected_account_id);
    const users = [...new Set(list.filter(event => event.user_id && event.api_key_id && event.group_id)
      .map(event => JSON.stringify([event.user_id, event.api_key_id, event.group_id])))];
    if (access.length !== 1 || selections.length !== 1 || users.length !== 1) continue;
    const end = access[0], selected = selections[0];
    if (!allowed.has(String(selected.selected_account_id)) || ![499, 500, 502, 503, 504, 524].includes(end.status_code) ||
        end.account_id && end.account_id !== selected.selected_account_id || !selected.model || !Number.isFinite(end.latency_ms)) continue;
    const endMs = millis(end.completed_at || end.ts), startMs = millis(selected.ts);
    if (!Number.isFinite(endMs) || startMs > endMs || Math.abs(startMs - (endMs - end.latency_ms)) > 5000) continue;
    const [userId, apiKeyId, groupId] = JSON.parse(users[0]).map(String);
    const digest = crypto.createHash('sha256').update(JSON.stringify(list.slice().sort((a, b) => millis(a.ts) - millis(b.ts) || JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex');
    candidates.push({ reference: `log:${requestId}`, kind: 'log', state: 'legacy_log', recorded: false,
      userId, apiKeyId, groupId, accountId: String(selected.selected_account_id), userEmail: '', groupName: '', billingType: 'unknown',
      models: [selected.model], stream: selected.stream, startMs, endMs, startUncertain: false, statusCode: end.status_code,
      rootIds: [requestId, end.client_request_id].filter(Boolean), ids: [],
      logSource: { request_id: requestId, client_request_id: end.client_request_id || '', group_id: Number(groupId),
        model: selected.model, ended_at: new Date(endMs).toISOString(), latency_ms: Math.round(end.latency_ms),
        status_code: end.status_code, stream: selected.stream === true, digest } });
  }
  return candidates;
}

function enrichErrorsFromLogs(errors, candidates) {
  const index = new Map();
  for (const candidate of candidates) for (const id of candidate.rootIds) {
    const list = index.get(id) || []; list.push(candidate); index.set(id, list);
  }
  return errors.map(row => {
    const matches = [...new Set([...(index.get(row.request_id) || []), ...(index.get(row.client_request_id) || [])])]
      .filter(item => item.userId === String(row.user_id) && item.apiKeyId === String(row.api_key_id) && item.groupId === String(row.group_id) &&
        item.accountId === String(row.account_id) && Math.abs(item.endMs - millis(row.created_at)) <= 5000);
    return matches.length === 1 ? { ...row, log_start_ms: matches[0].startMs } : row;
  });
}

module.exports = { BillingImportLogs, sanitizeLogEvent, buildLogCandidates, enrichErrorsFromLogs };
