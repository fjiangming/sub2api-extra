'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { failure, failureResult } = require('./conversation-push-transport');
const { jsonlChunks } = require('./conversation-jsonl-format');
const { abortable, pacedBody } = require('./conversation-jsonl-flow');
const { deliveryBody } = require('./conversation-envelope');

const PART_BYTES = 8 * 1024 ** 2;

async function session(transport, policy, outerSignal, guard, operation) {
  const target = policy.s3, baseUrl = new URL(target.endpoint), pinned = new Map();
  const stop = new AbortController(), abort = () => stop.abort(outerSignal?.reason);
  outerSignal?.addEventListener('abort', abort, { once: true });
  if (outerSignal?.aborted) abort();
  const lookup = (host, options, callback) => {
    const address = pinned.get(host.replace(/^\[|\]$/g, ''));
    if (!address) return callback(failure('ADDRESS_BLOCKED'));
    callback(null, options?.all ? [address] : address.address, address.family);
  };
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1, lookup });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1, lookup });
  const handler = new NodeHttpHandler({ httpAgent, httpsAgent, connectionTimeout: policy.timeoutSeconds * 1000, socketTimeout: policy.timeoutSeconds * 1000 });
  const boundedHandler = { metadata: handler.metadata, destroy: () => handler.destroy(), handle: async (request, options) => {
    const result = await handler.handle(request, options); let bytes = 0;
    const limit = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > 65536 ? failure('RESPONSE_TOO_LARGE') : null, chunk); } });
    pipeline(result.response.body, limit, { signal: options?.abortSignal }).catch(() => {});
    return { response: { ...result.response, body: limit } };
  } };
  const client = new S3Client({ endpoint: target.endpoint, region: target.region, forcePathStyle: target.forcePathStyle,
    credentials: { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey, ...(target.sessionToken ? { sessionToken: target.sessionToken } : {}) },
    maxAttempts: 1, followRegionRedirects: false, requestHandler: boundedHandler, requestChecksumCalculation: 'WHEN_REQUIRED' });
  let requestSignal;
  client.middlewareStack.add(next => async args => {
    const host = args.request.hostname.replace(/^\[|\]$/g, ''), base = baseUrl.hostname.replace(/^\[|\]$/g, '');
    if (host !== base && host !== `${target.bucket}.${base}`) throw failure('ADDRESS_BLOCKED');
    const address = await transport.resolve(host, policy.allowPrivateNetwork, requestSignal);
    await guard(); if (requestSignal.aborted) throw failure('ABORTED', true);
    pinned.set(host, address); return next(args);
  }, { step: 'finalizeRequest', name: 'validateConversationJsonlAddress', priority: 'low' });
  const request = async (command, extraMs = 0) => {
    await guard(); if (stop.signal.aborted) throw stop.signal.reason?.pushCode ? stop.signal.reason : failure('ABORTED', true);
    const controller = new AbortController(), cancel = () => controller.abort(stop.signal.reason); let timedOut = false;
    stop.signal.addEventListener('abort', cancel, { once: true }); requestSignal = controller.signal;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, policy.timeoutSeconds * 1000 + extraMs);
    // Do not depend on the SDK settling its promise after a socket or stream abort.
    try { return await abortable(client.send(command, { abortSignal: controller.signal }), controller.signal); }
    catch (error) {
      if (timedOut) throw failure('TIMEOUT', true);
      if (controller.signal.aborted) throw controller.signal.reason?.pushCode ? controller.signal.reason : failure('ABORTED', true);
      throw error;
    }
    finally { clearTimeout(timer); stop.signal.removeEventListener('abort', cancel); }
  };
  try {
    if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && policy.allowPrivateNetwork)) throw failure('ADDRESS_BLOCKED');
    return await operation(request);
  } catch (error) { return failureResult(!error.$metadata?.httpStatusCode && ['EXPORT_MEMORY','EXPORT_REQUEST_ID'].includes(error.code) ? failure(error.code, error.code === 'EXPORT_MEMORY') : error); }
  finally { outerSignal?.removeEventListener('abort', abort); client.destroy(); httpAgent.destroy(); httpsAgent.destroy(); }
}

async function sendJsonl(transport, policy, file, envelopes, signal, {
  guard = () => {}, onCreated = () => {}, beforeComplete = () => {}, checkpoint = async () => {},
  restoredParts = [], onPart = () => {}, streaming = false, getFile = () => file
} = {}) {
  const rate = (policy.s3.jsonl?.uploadMiBPerSecond ?? 2) * 1024 ** 2;
  return session(transport, policy, signal, guard, async request => {
    const target = { Bucket: policy.s3.bucket, Key: file.object_key };
    let uploadId = file.upload_id;
    if (!uploadId) {
      await checkpoint();
      const current = getFile() || file;
      const created = await request(new CreateMultipartUploadCommand({ ...target, ContentType: 'application/x-ndjson', ChecksumAlgorithm: 'SHA256',
        Metadata: { 'file-id': file.id, 'record-count': streaming ? 'streaming' : String(current.records), 'source': file.source,
          ...(streaming ? { streaming: 'true' } : {}) } }));
      if (!created.UploadId) throw failure('MULTIPART_INVALID');
      uploadId = created.UploadId; await onCreated(uploadId);
    }
    if (restoredParts.length && !file.upload_id) throw failure('MULTIPART_CHECKPOINT_INVALID');
    const initial = getFile() || file;
    let restoredBytes = 0;
    for (const [index, part] of restoredParts.entries()) {
      if (part.number !== index + 1 || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > PART_BYTES ||
        typeof part.etag !== 'string' || !part.etag || part.etag.length > 4096 || !/^[A-Za-z0-9+/]{43}=$/.test(part.sha256) ||
        restoredBytes + part.bytes > initial.bytes || part.bytes !== PART_BYTES && restoredBytes + part.bytes !== initial.bytes) throw failure('MULTIPART_CHECKPOINT_INVALID');
      restoredBytes += part.bytes;
    }
    if (restoredParts.length !== (file.uploaded_parts || 0) || restoredBytes !== (file.uploaded_bytes || 0)) throw failure('MULTIPART_CHECKPOINT_INVALID');
    const upload = { ...target, UploadId: uploadId }, parts = [], hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(PART_BYTES); let offset = 0, bytes = 0, records = 0, sinceYield = 0;
    const sendPart = async () => {
      await checkpoint(); await guard();
      const current = getFile() || file;
      if (streaming && offset < PART_BYTES && (!current.sealed_at || bytes !== current.bytes)) throw failure('UPLOAD_STALLED', true);
      const body = buffer.subarray(0, offset), checksum = crypto.createHash('sha256').update(body).digest('base64'), number = parts.length + 1;
      const saved = restoredParts[number - 1];
      let etag;
      if (saved) {
        if (saved.bytes !== body.length || saved.sha256 !== checksum) throw failure('JSONL_CONTENT_CHANGED');
        etag = saved.etag;
      } else {
        const stream = pacedBody(body, rate, signal);
        try {
          const part = await request(new UploadPartCommand({ ...upload, PartNumber: number, Body: stream, ContentLength: body.length, ChecksumSHA256: checksum }),
            Math.ceil(body.length * 1000 / rate));
          if (!part.ETag) throw failure('MULTIPART_INVALID');
          etag = part.ETag;
          await onPart({ number, bytes: body.length, etag, sha256: checksum }, uploadId);
        } finally { stream.destroy(); }
      }
      parts.push({ PartNumber: number, ETag: etag, ChecksumSHA256: checksum }); offset = 0;
    };
    for await (let envelope of envelopes) {
      await checkpoint(); await guard(); records++;
      for (const chunk of jsonlChunks(deliveryBody(envelope))) {
        const source = Buffer.from(chunk); hash.update(source); bytes += source.length;
        const current = getFile() || file;
        if (bytes > current.bytes) throw failure('JSONL_CONTENT_CHANGED');
        for (let index = 0; index < source.length;) {
          const length = Math.min(buffer.length - offset, source.length - index);
          source.copy(buffer, offset, index, index + length); offset += length; index += length;
          if (offset === buffer.length) await sendPart();
        }
        sinceYield += source.length;
        if (sinceYield >= 262144) { sinceYield = 0; await new Promise(resolve => setImmediate(resolve)); await checkpoint(); }
      }
      envelope = null;
    }
    const current = getFile() || file;
    if (offset) await sendPart();
    if (streaming && !current.sealed_at) throw failure('UPLOAD_STALLED', true);
    const final = getFile() || file;
    if (bytes !== final.bytes || records !== final.records || !parts.length || restoredParts.length > parts.length) throw failure('JSONL_CONTENT_CHANGED');
    await checkpoint(); await beforeComplete(); await guard();
    const completed = await request(new CompleteMultipartUploadCommand({ ...upload, MultipartUpload: { Parts: parts } }));
    return { status: 'sent', httpStatus: completed.$metadata.httpStatusCode, bytes, records, sha256: hash.digest('hex') };
  });
}

async function abortJsonl(transport, policy, file) {
  const result = await session(transport, policy, null, () => {}, async request => {
    const response = await request(new AbortMultipartUploadCommand({ Bucket: policy.s3.bucket, Key: file.object_key, UploadId: file.upload_id }));
    return { status: 'sent', httpStatus: response.$metadata.httpStatusCode };
  });
  // A lost Complete/Abort receipt can leave an already-removed upload ID.
  if (result.httpStatus === 404) return { status: 'sent', httpStatus: 404 };
  return result;
}

module.exports = { sendJsonl, abortJsonl };
