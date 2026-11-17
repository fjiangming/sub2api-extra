'use strict';

const { decodeBody } = require('./conversation-redaction');

const COMPLETION_VERSION = 1;

// This is application-level evidence only. It must never rewrite the collector's transport flags.
function inspectCompletion(raw, metadata, { maxOutputBytes = 256 * 1024 ** 2 } = {}) {
  let remaining = Math.min(maxOutputBytes,8 * 1024 ** 2), evidence = '', failureEvidence = '', incompleteEvidence = '', failed = false, incomplete = false, anthropic = false;
  const states = new Map();
  const result = (status, code) => ({ upstream_status: status, upstream_evidence: code, completion_version: COMPLETION_VERSION });
  const state = (key, value, code = '') => {
    if (states.size >= 256 && !states.has(key)) throw new Error('resource');
    states.set(key, value); if (code) evidence = code;
  };
  const document = (value, eventName = '') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('format');
    if (value.type && eventName && value.type !== eventName) throw new Error('format');
    if (value.type === 'error' && value.error || !value.type && value.error && !value.choices && !value.output) { failed = true; failureEvidence = 'protocol.error'; return; }
    if (/^response\.(?:created|in_progress|completed|failed|incomplete|cancelled)$/.test(value.type || '')) {
      const response = value.response;
      if (!response || typeof response !== 'object') throw new Error('format');
      const terminal = value.type.slice(9), key = 'responses:' + (response.id || 'single');
      if (['completed','failed','incomplete','cancelled'].includes(terminal)) {
        if (response.status !== terminal) throw new Error('format');
        state(key, terminal, value.type); failed ||= ['failed','cancelled'].includes(terminal); incomplete ||= terminal === 'incomplete';
        if (['failed','cancelled'].includes(terminal)) failureEvidence = value.type;
        if (terminal === 'incomplete') incompleteEvidence = value.type;
      } else state(key, 'pending');
      return;
    }
    if (value.object === 'response' && typeof value.status === 'string') {
      if (!['completed','failed','incomplete','cancelled','in_progress','queued'].includes(value.status)) throw new Error('format');
      state('responses:' + (value.id || 'single'), value.status, 'response.' + value.status);
      failed ||= ['failed','cancelled'].includes(value.status); incomplete ||= value.status === 'incomplete';
      if (['failed','cancelled'].includes(value.status)) failureEvidence = 'response.' + value.status;
      if (value.status === 'incomplete') incompleteEvidence = 'response.incomplete';
      return;
    }
    if (Array.isArray(value.choices) && /^(?:chat\.completion(?:\.chunk)?|text_completion)$/.test(value.object || '')) {
      for (const choice of value.choices) {
        if (!Number.isInteger(choice.index)) throw new Error('format');
        const finish = choice.finish_reason, key = 'chat:' + (value.id || 'single') + ':' + choice.index;
        if (finish === null || finish === undefined) { if (!states.has(key)) state(key, 'pending'); }
        else if (['stop','tool_calls','function_call'].includes(finish)) state(key, 'completed', 'chat.finish_reason');
        else { state(key, 'incomplete', 'chat.finish_reason'); incomplete = true; incompleteEvidence = 'chat.finish_reason'; }
      }
      return;
    }
    if (value.type === 'message_start' && value.message?.type === 'message') { anthropic = true; state('anthropic', 'pending'); }
    else if (value.type === 'message' && value.role === 'assistant' && value.stop_reason) state('anthropic', 'completed', 'message.stop_reason');
    else if (value.type === 'message_stop' && anthropic) state('anthropic', 'completed', 'message_stop');
    const candidates = value.candidates || value.response?.candidates;
    if (Array.isArray(candidates)) for (const candidate of candidates) {
      const key = 'gemini:' + (candidate.index ?? 0);
      if (candidate.finishReason) {
        const completed = candidate.finishReason === 'STOP';
        state(key, completed ? 'completed' : 'incomplete', 'gemini.finishReason'); incomplete ||= !completed;
        if (!completed) incompleteEvidence = 'gemini.finishReason';
      } else if (!states.has(key)) state(key, 'pending');
    }
  };
  const read = (body, encoding = '') => {
    const text = decodeBody(body, encoding, remaining); remaining -= Buffer.byteLength(text); return text;
  };
  const json = (text, name) => { if (text.trim() && text.trim() !== '[DONE]') document(JSON.parse(text), name); };
  const sse = text => {
    let parts = [], name = '';
    for (const match of text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
      if (!match[0]) break;
      const line = match[1];
      if (!line) { if (parts.length) json(parts.join('\n'), name); parts = []; name = ''; }
      else if (line === 'data' || line.startsWith('data:')) parts.push(line === 'data' ? '' : line.slice(line.startsWith('data: ') ? 6 : 5));
      else if (line.startsWith('event:')) name = line.slice(line.startsWith('event: ') ? 7 : 6);
    }
    if (parts.length || name) throw new Error('framing');
  };
  try {
    if (metadata.status >= 400) return result('failed', 'http_error');
    if (raw.frames.length) {
      for (const frame of raw.frames) if (frame.direction === 'in') {
        if (frame.binary) return result('unverified', 'binary');
        json(read(frame.body));
      }
    } else if (metadata.protocol === 'SSE') sse(read(raw.response, metadata.encoding));
    else {
      const text = read(raw.response, metadata.encoding);
      if (text.trim()) {
        try { document(JSON.parse(text)); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          for (const line of text.split(/\r?\n/)) if (line.trim()) json(line);
        }
      }
    }
    if (failed) return result('failed', failureEvidence);
    if (incomplete) return result('incomplete', incompleteEvidence);
    if (states.size && [...states.values()].every(value => value === 'completed')) return result('completed', evidence);
    return result('unknown', states.size ? 'no_terminal_event' : 'no_completion_evidence');
  } catch (error) {
    return result('unverified', error.message === 'framing' ? 'incomplete_event' :
      error.message === 'resource' || error.message === 'REDACTION_RESOURCE_LIMIT' ? 'resource' : 'invalid_format');
  }
}

module.exports = { inspectCompletion, COMPLETION_VERSION };
