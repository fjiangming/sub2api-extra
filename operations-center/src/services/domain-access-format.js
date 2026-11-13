'use strict';

const crypto = require('node:crypto');
const { DateTime } = require('luxon');

function domain(value) {
  const text = String(value || '').trim().toLowerCase().replace(/:\d{1,5}$/, '').replace(/\.$/, '');
  return text.length <= 253 && text.includes('.') && text.split('.').every(part =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ? text : null;
}

// Persist a route category, never an arbitrary path segment, query or credential.
function route(value) {
  const text = String(value || '').split('?')[0];
  if (/^\/(?:v1|api\/v1)\/(?:messages|chat\/completions|responses|models|embeddings|images\/generations|audio\/transcriptions)\/?$/.test(text)) return text.replace(/\/$/, '');
  if (/^\/api\/v1\/auth\/(?:me|login|register|refresh)$/.test(text)) return '/api/v1/auth/*';
  if (/^\/v1beta\/models\//.test(text)) return '/v1beta/models/*';
  if (text === '/') return '/';
  if (text.startsWith('/api/')) return '/api/*';
  if (text.startsWith('/v1/')) return '/v1/*';
  return '/web/*';
}

function parseLine(line, { timezone = 'Asia/Shanghai', now = Date.now(), history = false } = {}) {
  if (Buffer.byteLength(line) > 16384) return null;
  if (!history) {
    let row;
    try { row = JSON.parse(line); } catch { return null; }
    const host = domain(row.host), at = Date.parse(row.at);
    if (row.version !== 1 || row.source !== 'operations-domain-gateway' || !host ||
        !Number.isFinite(at) || at > now + 300000 || !/^[a-f0-9]{32}$/.test(row.gateway_id) ||
        !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(row.method) ||
        !Number.isInteger(Number(row.status)) || Number(row.status) < 100 || Number(row.status) > 599) return null;
    const trusted = row.backend_id === row.gateway_id;
    const path = route(row.path);
    const identity = !trusted ? 'unverified' : path === '/' || path === '/web/*' ? 'anonymous' : 'pending';
    return { kind: 'request', id: row.gateway_id, at, day: DateTime.fromMillis(at, { zone: timezone }).toISODate(),
      domain: host, path, method: row.method, status: Number(row.status), trusted: trusted ? 1 : 0,
      identity, reason: trusted ? (identity === 'anonymous' ? 'no_authenticated_record' : 'awaiting_exact_record') : 'backend_id_mismatch',
      fingerprint: crypto.createHash('sha256').update(JSON.stringify([host, at, path, row.method, Number(row.status), trusted])).digest('hex') };
  }
  // Default combined logs cannot prove Host. Referer remains a separate historical clue.
  const combined = /^\S+ \S+ \S+ \[([^\]]+)\] "([A-Z]+) ([^" ]+) HTTP\/[^" ]+" \d{3} \S+ "([^"\r\n]*)"/.exec(line);
  if (combined) {
    let host;
    try { host = domain(new URL(combined[4]).hostname); } catch { return null; }
    const date = DateTime.fromFormat(combined[1], 'dd/LLL/yyyy:HH:mm:ss ZZZ', { locale: 'en', setZone: true });
    if (!host || !date.isValid) return null;
    return clue(line, host, date.toMillis(), 'referer', route(combined[3]), timezone, now);
  }
  const errorHost = /\bhost: "([^"\r\n]+)"/.exec(line);
  const errorDate = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/.exec(line);
  if (!errorHost || !errorDate) return null;
  const date = DateTime.fromFormat(errorDate[1], 'yyyy/MM/dd HH:mm:ss', { zone: timezone });
  const host = domain(errorHost[1]);
  if (!date.isValid || !host) return null;
  return clue(line, host, date.toMillis(), 'host', route(/request: "[A-Z]+ ([^" ]+)/.exec(line)?.[1]), timezone, now);
}

function clue(line, host, at, evidence, path, timezone, now) {
  if (at > now + 300000) return null;
  return { kind: 'history', id: crypto.createHash('sha256').update(line).digest('hex'), domain: host, at,
    day: DateTime.fromMillis(at, { zone: timezone }).toISODate(), evidence, path };
}

module.exports = { domain, route, parseLine };
