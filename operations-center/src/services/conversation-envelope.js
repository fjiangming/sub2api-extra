'use strict';

const crypto = require('node:crypto');
const { isUtf8 } = require('node:buffer');
const zlib = require('node:zlib');
const { processingBudget } = require('./conversation-memory');

const ENVELOPE_VERSION = 4;

function formatBodies(raw, { version = ENVELOPE_VERSION, encoding = '' } = {}) {
  if (![1, 2, 3, ENVELOPE_VERSION].includes(version)) throw new Error('UNSUPPORTED_ENVELOPE_VERSION');
  const convert = (value, reason = '') => {
    const bytes = Buffer.from(value, 'base64');
    const checksum = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    if (version === 1) return { body: value, encoding: 'base64', reason: '', checksum };
    if (!reason && !isUtf8(bytes)) reason = 'INVALID_UTF8';
    return { body: reason ? value : bytes.toString('utf8'), encoding: reason ? 'base64' : 'utf-8', reason, checksum };
  };
  // Preserve compressed and binary wire bytes; forcing them into text would lose information.
  const request = convert(raw.request), response = convert(raw.response, encoding && encoding !== 'identity' ? 'COMPRESSED_CONTENT' : '');
  const frames = raw.frames.map(frame => convert(frame.body, frame.binary ? 'BINARY_FRAME' : ''));
  const checksums = { request: request.checksum, response: response.checksum, frames: frames.map(frame => frame.checksum) };
  if (version === 1) return { body_encoding: 'base64', request: raw.request, response: raw.response, frames: raw.frames, checksums };
  const reasons = {};
  if (request.reason) reasons.request = request.reason;
  if (response.reason) reasons.response = response.reason;
  if (frames.some(frame => frame.reason)) reasons.frames = frames.map(frame => frame.reason);
  return { body_encoding: [request, response, ...frames].every(body => body.encoding === 'utf-8') ? 'utf-8' : 'mixed',
    body_encodings: { request: request.encoding, response: response.encoding, frames: frames.map(frame => frame.encoding) },
    ...(Object.keys(reasons).length ? { body_encoding_reasons: reasons } : {}),
    request: request.body, response: response.body, frames: raw.frames.map((frame, index) => ({ ...frame, body: frames[index].body })), checksums };
}

function deliveryBody(envelope, { maxOutputBytes } = {}) {
  if (!['sub2api.conversation.v3', 'sub2api.conversation.v4'].includes(envelope.schema)) return envelope;
  const identity = {};
  if (envelope.schema === 'sub2api.conversation.v4') {
    const requestId = envelope.metadata?.request_id;
    if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)) {
      throw Object.assign(new Error('EXPORT_REQUEST_ID'), { code: 'EXPORT_REQUEST_ID' });
    }
    identity.request_id = requestId;
  }
  const dataUri = (body, encoding = '') => 'data:application/octet-stream' +
    (encoding && encoding !== 'identity' ? ';content-encoding=' + encodeURIComponent(encoding) : '') + ';base64,' + body;
  const convert = (body, representation, encoding = '', binary = false) => {
    if (representation === 'utf-8') return body;
    if (binary) return dataUri(body);
    const wire = Buffer.from(body, 'base64');
    let bytes = wire;
    if (encoding && encoding !== 'identity' && bytes.length) {
      const decompress = { gzip: zlib.gunzipSync, br: zlib.brotliDecompressSync, deflate: zlib.inflateSync, zstd: zlib.zstdDecompressSync }[encoding];
      if (!decompress) return dataUri(body, encoding);
      const limit = maxOutputBytes ?? Math.floor(processingBudget() / 4);
      if (limit < 1) throw Object.assign(new Error('EXPORT_MEMORY'), { code: 'EXPORT_MEMORY' });
      try {
        const result = decompress(wire, { maxOutputLength: limit, info: true });
        // Never discard a suffix the decoder did not consume.
        if (result.engine.bytesWritten !== wire.length) return dataUri(body, encoding);
        bytes = result.buffer;
      } catch (error) {
        if (error.code === 'ERR_BUFFER_TOO_LARGE') throw Object.assign(new Error('EXPORT_MEMORY'), { code: 'EXPORT_MEMORY' });
        return dataUri(body, encoding);
      }
    }
    return isUtf8(bytes) ? bytes.toString('utf8') : dataUri(body, encoding);
  };
  const request = convert(envelope.request, envelope.body_encodings.request);
  const response = convert(envelope.response, envelope.body_encodings.response, envelope.metadata.encoding);
  if (!envelope.frames.length) return { ...identity, request, response };
  const outgoing = request ? [request] : [], incoming = response ? [response] : [];
  envelope.frames.forEach((frame, index) => {
    const body = convert(frame.body, envelope.body_encodings.frames[index], '', frame.binary);
    (frame.direction === 'out' ? outgoing : incoming).push(body);
  });
  return { ...identity, request: outgoing, response: incoming };
}

function deliveryBodyFromRaw(raw, { version = ENVELOPE_VERSION, requestId, encoding = '' }, options) {
  if (![3, 4].includes(version)) throw new Error('UNSUPPORTED_ENVELOPE_VERSION');
  // Downloads need the public body only; avoid building unused checksums and intermediate decoded envelopes.
  return deliveryBody({ schema: 'sub2api.conversation.v' + version, metadata: { request_id: requestId, encoding },
    request: raw.request, response: raw.response, frames: raw.frames,
    body_encodings: { request: 'base64', response: 'base64', frames: raw.frames.map(() => 'base64') } }, options);
}

function formatDeliveryBodies(raw, options) {
  if (![3, 4].includes(options.version)) return formatBodies(raw, options);
  const body = deliveryBodyFromRaw(raw, options, { maxOutputBytes: options.maxOutputBytes });
  // Keep routing metadata separate while reusing the decoded public body without another conversion.
  return { body_encoding: 'utf-8', body_encodings: { request: 'utf-8', response: 'utf-8', frames: [] },
    request: body.request, response: body.response, frames: [] };
}

module.exports = { ENVELOPE_VERSION, formatBodies, deliveryBody, deliveryBodyFromRaw, formatDeliveryBodies };
