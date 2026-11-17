'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { REDACTION_VERSION, fieldKind, protocolField, assertInspectable, replacePatterns } = require('./conversation-sensitive');

const emailLocal = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]/i;
const emailDomain = /[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/iy;

function replaceEmails(text, replace) {
  const parts = []; let cursor = 0, search = 0;
  // Anchor domain checks at each @ so long non-email tokens are scanned once.
  for (let at; (at = text.indexOf('@', search)) !== -1;) {
    search = at + 1;
    let start = at;
    while (start > cursor && emailLocal.test(text[start - 1])) start--;
    if (start === at) continue;
    emailDomain.lastIndex = at + 1;
    const domain = emailDomain.exec(text);
    if (!domain) continue;
    const end = emailDomain.lastIndex;
    parts.push(text.slice(cursor, start), replace(text.slice(start, end)));
    cursor = search = end;
  }
  if (!parts.length) return text;
  parts.push(text.slice(cursor));
  return parts.join('');
}

function decodeBody(buffer, encoding = '', maxOutputBytes = 256 * 1024 * 1024) {
  // Processing memory protection never changes the stored original bytes.
  if (!buffer.length && !encoding) return '';
  if (maxOutputBytes < 1 || buffer.length > maxOutputBytes) throw new Error('REDACTION_RESOURCE_LIMIT');
  const options = { maxOutputLength: maxOutputBytes };
  if (encoding === 'gzip') buffer = zlib.gunzipSync(buffer, options);
  else if (encoding === 'br') buffer = zlib.brotliDecompressSync(buffer, options);
  else if (encoding === 'deflate') buffer = zlib.inflateSync(buffer, options);
  else if (encoding === 'zstd' && zlib.zstdDecompressSync) buffer = zlib.zstdDecompressSync(buffer, options);
  else if (encoding && encoding !== 'identity') throw new Error('UNSUPPORTED_ENCODING');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

// Locate string values without parsing/re-serializing numbers, keys or document formatting.
function tokens(text) {
  JSON.parse(text);
  const values = []; let at = 0;
  const space = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) { const ch = text[at++]; if (ch === '\\') at++; else if (ch === '"') break; }
    return { start, end: at, value: JSON.parse(text.slice(start, at)) };
  };
  function walk(field, depth = 0, path = []) {
    if (depth > 100) throw new Error('DOCUMENT_TOO_DEEP');
    space();
    if (text[at] === '"') { values.push({ ...string(), field, path }); return; }
    if (text[at] === '{') {
      at++; space();
      while (text[at] !== '}') {
        const key = string().value; space(); at++; walk(key, depth + 1, [...path, key]); space();
        if (text[at] !== ',') break; at++; space();
      }
      at++; return;
    }
    if (text[at] === '[') {
      at++; space();
      let index = 0;
      while (text[at] !== ']') { walk(field, depth + 1, [...path, index++]); space(); if (text[at] !== ',') break; at++; }
      at++; return;
    }
    const start = at;
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
    const raw = text.slice(start, at);
    if (/^-?\d/.test(raw)) values.push({ start, end: at, value: raw, numeric: true, field, path });
  }
  walk(''); return values;
}

function streamGroup(token, parsed) {
  const p = token.path, identity = parsed.item_id || parsed.response_id || parsed.id || '';
  if (p.length === 1 && p[0] === 'delta') return { key: ['responses', parsed.type, identity, parsed.output_index, parsed.content_index].join(':'), json: String(parsed.type).includes('arguments') };
  if (parsed.type === 'content_block_delta' && p[0] === 'delta' && ['text', 'thinking', 'partial_json'].includes(p[1])) {
    return { key: ['anthropic', parsed.index, p[1]].join(':'), json: p[1] === 'partial_json' };
  }
  if (p[0] === 'choices' && p[2] === 'delta') {
    const choice = parsed.choices[p[1]], tool = choice.delta.tool_calls?.[p[4]];
    if (['content', 'reasoning_content', 'reasoning'].includes(p[3])) return { key: ['chat', identity, choice.index ?? p[1], p[3]].join(':'), json: false };
    if (p[3] === 'tool_calls' && p[5] === 'function' && p[6] === 'arguments') return { key: ['chat-tool', identity, choice.index ?? p[1], tool?.index ?? p[4]].join(':'), json: true };
  }
  if (p[0] === 'candidates' && p[2] === 'content' && p[3] === 'parts' && p[5] === 'text') return { key: ['gemini', parsed.candidates[p[1]]?.index ?? p[1], p[4]].join(':'), json: false };
  return null;
}

function replaceUrls(text, transform, policy, placeholder) {
  const parts = []; let cursor = 0;
  const component = (raw, key = '', form = false) => {
    let value, label;
    try { value = decodeURIComponent(form ? raw.replaceAll('+', ' ') : raw); label = decodeURIComponent(key.replaceAll('+', ' ')); }
    catch { throw new Error('UNINSPECTABLE_CONTENT'); }
    const kind = /^x-amz-|^x-goog-|^(?:sig|signature|se|sp|sv)$/i.test(label) && policy.secret ? 'secret' : fieldKind(label, policy);
    const next = kind && value ? placeholder(kind, value) : transform(value);
    return next === value ? raw : encodeURIComponent(next);
  };
  const parameters = raw => raw.split('&').map(part => {
    const equal = part.indexOf('=');
    return equal < 0 ? component(part, '', true) : part.slice(0, equal + 1) + component(part.slice(equal + 1), part.slice(0, equal), true);
  }).join('&');
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s"'<>]+/gi)) {
    const raw = match[0];
    try { new URL(raw); } catch { continue; }
    const [, scheme, authority, path, query = '', fragment = ''] = raw.match(/^([a-z]+:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i);
    const at = authority.lastIndexOf('@');
    const host = at < 0 ? authority : authority.slice(at + 1);
    const auth = at < 0 ? '' : (policy.secret ? encodeURIComponent(placeholder('secret', authority.slice(0, at))) : transform(authority.slice(0, at))) + '@';
    const hash = fragment.slice(1), question = hash.indexOf('?');
    const nextHash = question >= 0 ? hash.slice(0, question + 1) + parameters(hash.slice(question + 1)) : hash.includes('=') ? parameters(hash) : hash.split('/').map(value => component(value)).join('/');
    parts.push(transform(text.slice(cursor, match.index)), scheme + auth + transform(host) + path.split('/').map(value => component(value)).join('/') +
      (query ? '?' + parameters(query.slice(1)) : '') + (fragment ? '#' + nextHash : ''));
    cursor = match.index + raw.length;
  }
  if (!parts.length) return transform(text);
  parts.push(transform(text.slice(cursor))); return parts.join('');
}

function createRedactor(policy, salt) {
  const hits = new Map();
  const known = new Map();
  const warnings = new Set();
  const kindFor = token => {
    const schema = token.path.some(field => ['properties','$defs','definitions'].includes(field));
    const kind = fieldKind(token.field, policy) || (!schema && token.path.slice(0, -1).map(field => fieldKind(field, policy)).find(Boolean)) || '';
    return ['identity','personal','phone'].includes(kind) && policy.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(token.value) ? 'email' : kind;
  };
  function placeholder(kind, match) {
    const digest = crypto.createHmac('sha256', salt).update(kind + '\0' + match).digest('hex').slice(0, 12).toUpperCase();
    const replacement = `<${kind.toUpperCase()}_${digest}>`;
    hits.set(replacement, { name: kind, replacement, count: (hits.get(replacement)?.count || 0) + 1 });
    return replacement;
  }
  function replaceText(value) {
    let text = value;
    for (const [match, kind] of [...known].sort((a, b) => b[0].length - a[0].length)) {
      if (text.includes(match)) text = text.split(/(<[A-Z]+_[A-F0-9]{12}>)/g).map((part, index) => index % 2 ? part : part.replaceAll(match, (_value, at) => {
        if (kind === 'personal' && (/[A-Za-z0-9_]/.test(match[0]) && /[A-Za-z0-9_]/.test(part[at - 1] || '') ||
          /[A-Za-z0-9_]/.test(match.at(-1)) && /[A-Za-z0-9_]/.test(part[at + match.length] || ''))) return match;
        return placeholder(kind, match);
      })).join('');
    }
    text = replacePatterns(text, { secret: policy.secret }, placeholder);
    text = policy.email ? replaceEmails(text, match => placeholder('email', match)) : text;
    text = replacePatterns(text, { ...policy, secret: false }, placeholder);
    // Decode URL parameter values independently, preserving the URL spelling and all other parameters.
    text = text.replace(/([?&#]([^\s?&#=]{1,80})=)([^\s&#"'<>]{1,4096})/g, (all, prefix, key, raw) => {
      let decoded, label;
      try { decoded = decodeURIComponent(raw); label = decodeURIComponent(key); } catch { return all; }
      const kind = /^x-amz-|^x-goog-|^(?:sig|signature|se|sp|sv)$/i.test(label) && policy.secret ? 'secret' : fieldKind(label, policy);
      const next = kind ? placeholder(kind, decoded) : replacePatterns(policy.email ? replaceEmails(decoded, m => placeholder('email', m)) : decoded, policy, placeholder);
      return next === decoded ? all : prefix + encodeURIComponent(next);
    });
    return text;
  }
  function replace(value) {
    // Inspect URL components without allowing an email match to consume the host, path or parameter name.
    let text = replaceUrls(value, replaceText, policy, placeholder);
    for (const rule of policy.custom) {
      const count = text.split(rule.from).length - 1;
      if (count) {
        text = text.replaceAll(rule.from, rule.to);
        const key = 'custom:' + rule.to;
        hits.set(key, { name: 'custom', replacement: rule.to, count: (hits.get(key)?.count || 0) + count });
      }
    }
    return text;
  }
  function documents(text) {
    if (!text.trim()) return [];
    const result = [];
    const add = (value, start, segments, validJson = false) => {
      if (!value.trim() || value.trim() === '[DONE]') return;
      const json = validJson || /^[\s]*[\[{]/.test(value);
      if (json) { try { JSON.parse(value); } catch { throw new Error('INVALID_JSON'); } }
      result.push({ text: value, start, segments, json });
    };
    if (!/^(?:data:|event:|id:|retry:|:)/m.test(text)) {
      // NDJSON is common on compatible upstreams; never reserialize the documents.
      try { JSON.parse(text); add(text, 0, undefined, true); }
      catch {
        if (/^[\s]*[\[{]/.test(text) && text.trim().split(/\r?\n/).length > 1) {
          let offset = 0;
          for (const line of text.split(/(?<=\n)/)) { add(line, offset); offset += line.length; }
        } else add(text, 0);
      }
      return result;
    }
    let offset = 0, parts = [], segments = [], length = 0;
    const flush = () => { add(parts.join('\n'), 0, segments); parts = []; segments = []; length = 0; };
    for (const match of text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
      const line = match[1];
      if (!line) flush();
      else if (line === 'data' || line.startsWith('data:')) {
        const prefix = line === 'data' ? 4 : line.startsWith('data: ') ? 6 : 5, value = line.slice(prefix);
        segments.push({ start: length, end: length + value.length, raw: offset + prefix });
        parts.push(value); length += value.length + 1;
      } else if (line.startsWith(':') || !/^(?:event|id|retry):/.test(line)) {
        const colon = line.indexOf(':'), prefix = colon < 0 ? 0 : colon + 1;
        result.push({ text: line.slice(prefix), start: offset + prefix, json: false });
      }
      offset += match[0].length;
    }
    flush();
    return result;
  }
  function nested(value, depth) {
    if (/^[\s]*[\[{]/.test(value)) {
      try { JSON.parse(value); } catch { return replace(value); }
      return redactDocuments([value], depth + 1)[0];
    }
    return replace(value);
  }
  function learn(texts, depth) {
    if (depth > 8) throw new Error('NESTED_ARGUMENTS_TOO_DEEP');
    for (const text of texts) for (const document of documents(text)) {
      if (!document.json) continue;
      const parsed = JSON.parse(document.text);
      for (const token of tokens(document.text)) {
        const warning = assertInspectable(token, parsed, depth);
        if (warning) { warnings.add(warning); continue; }
        if (protocolField(token, parsed, depth)) continue;
        const kind = kindFor(token);
        if (kind && ['personal','identity','financial','secret','device'].includes(kind) && token.value.length >= (kind === 'personal' ? 2 : 4) && token.value.length <= 4096) {
          if (known.size >= 256 && !known.has(token.value)) throw new Error('REDACTION_RESOURCE_LIMIT');
          if (!known.has(token.value)) known.set(token.value, kind);
        }
        if (!token.numeric && /^[\s]*[\[{]/.test(token.value)) {
          try { JSON.parse(token.value); } catch { continue; }
          learn([token.value], depth + 1);
        }
      }
    }
  }
  function redactDocuments(texts, depth = 0) {
    if (depth > 8) throw new Error('NESTED_ARGUMENTS_TOO_DEEP');
    learn(texts, depth);
    const edits = texts.map(() => []), deltas = new Map();
    for (let file = 0; file < texts.length; file++) for (const document of documents(texts[file])) {
      if (!document.json) {
        for (const segment of document.segments || [{ start: 0, end: document.text.length, raw: document.start }]) {
          const before = document.text.slice(segment.start, segment.end), value = replace(before);
          if (document.segments && /[\r\n]/.test(value)) throw new Error('UNSAFE_SSE_REPLACEMENT');
          if (value !== before) edits[file].push({ start: segment.raw, end: segment.raw + before.length, value, literal: true });
        }
        continue;
      }
      const parsed = JSON.parse(document.text);
      for (const token of tokens(document.text)) {
        const segment = document.segments?.find(part => token.start >= part.start && token.end <= part.end);
        if (document.segments && !segment) throw new Error('UNSAFE_SSE_REPLACEMENT');
        const base = segment ? segment.raw - segment.start : document.start;
        const entry = { ...token, start: base + token.start, end: base + token.end, file };
        const warning = assertInspectable(token, parsed, depth);
        if (warning || protocolField(token, parsed, depth)) {
          if (warning) warnings.add(warning);
          // Numeric IDs are often mistaken for phone numbers. Protocol identities stay exact.
          if (policy.custom.some(rule => token.value.includes(rule.from) && rule.from !== rule.to)) throw new Error('PROTECTED_FIELD_MATCH');
          continue;
        }
        const group = streamGroup(token, parsed);
        if (group) {
          if (!deltas.has(group.key)) deltas.set(group.key, { entries: [], json: group.json });
          deltas.get(group.key).entries.push(entry); continue;
        }
        let value;
        const kind = kindFor(token);
        if (kind && token.value) value = placeholder(kind, token.value);
        else if (!token.numeric && /^[\s]*[\[{]/.test(token.value)) value = nested(token.value, depth);
        else value = token.numeric ? replacePatterns(token.value, { identity: policy.identity, financial: policy.financial }, placeholder) : replace(token.value);
        if (value !== token.value) edits[file].push({ ...entry, value });
      }
    }
    // Mask across SSE/WS text-delta boundaries while retaining every event and its structural fields.
    for (const { entries, json } of deltas.values()) {
      const joined = entries.map(entry => entry.value).join('');
      const masked = json ? nested(joined, depth) : replace(joined);
      if (masked !== joined) {
        let common = 0;
        while (common < joined.length && common < masked.length && joined[common] === masked[common]) common++;
        let suffix = 0;
        while (suffix < joined.length - common && suffix < masked.length - common && joined.at(-1 - suffix) === masked.at(-1 - suffix)) suffix++;
        const end = joined.length - suffix, replacement = masked.slice(common, masked.length - suffix); let offset = 0, inserted = false;
        for (const entry of entries) {
          const first = Math.max(0, common - offset), last = Math.min(entry.value.length, end - offset);
          if (first < last) {
            const value = entry.value.slice(0, first) + (inserted ? '' : replacement) + entry.value.slice(last);
            inserted = true; edits[entry.file].push({ ...entry, value });
          }
          offset += entry.value.length;
        }
      }
    }
    return texts.map((text, file) => {
      if (edits[file].length) {
        const parts = []; let offset = 0;
        for (const edit of edits[file].sort((a, b) => a.start - b.start)) {
          parts.push(text.slice(offset, edit.start), edit.literal ? edit.value : JSON.stringify(edit.value)); offset = edit.end;
        }
        parts.push(text.slice(offset)); text = parts.join('');
      }
      documents(text);
      return text;
    });
  }
  return { process: redactDocuments, hits: () => [...hits.values()], warnings: () => [...warnings].sort() };
}

function maskPayload(raw, policy, salt, encoding = '', { maxOutputBytes = 256 * 1024 * 1024 } = {}) {
  const redactor = createRedactor(policy, salt);
  let remaining = maxOutputBytes;
  const decode = (body, compression = '') => {
    const text = decodeBody(body, compression, remaining);
    remaining -= Buffer.byteLength(text);
    return text;
  };
  if (raw.frames.length) {
    if (raw.frames.some(frame => frame.binary)) throw new Error('BINARY_MESSAGE_REQUIRES_ORIGINAL_MODE');
    const output = redactor.process(raw.frames.map(frame => decode(frame.body)));
    const frames = raw.frames.map((frame, index) => ({ ...frame, body: Buffer.from(output[index]) }));
    return { payload: { request: frames.find(frame => frame.direction === 'out')?.body || Buffer.alloc(0),
      response: frames.findLast(frame => frame.direction === 'in')?.body || Buffer.alloc(0), frames }, hits: redactor.hits(), warnings: redactor.warnings() };
  }
  const inputs = [decode(raw.request), decode(raw.response, encoding)];
  const output = redactor.process(inputs);
  return { payload: { request: Buffer.from(output[0]), response: Buffer.from(output[1]),
    frames: raw.frames.map((frame, index) => ({ ...frame, body: Buffer.from(output[index + 2]) })) }, hits: redactor.hits(), warnings: redactor.warnings() };
}

module.exports = { decodeBody, createRedactor, maskPayload, REDACTION_VERSION };
