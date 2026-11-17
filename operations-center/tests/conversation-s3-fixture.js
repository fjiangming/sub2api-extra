'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

async function s3Receiver({ beforeRequest } = {}) {
  const uploads = new Map(), objects = new Map(), requests = [], completed = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks), url = new URL(req.url, 'http://localhost');
    const entry = { method: req.method, path: decodeURIComponent(url.pathname), query: url.searchParams, body, headers: req.headers };
    requests.push(entry);
    const reject = (status, code) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(`<Error><Code>${code}</Code></Error>`); };
    try {
      if (beforeRequest && await beforeRequest(entry, res) === false) return;
      assert(req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 '));
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        const id = crypto.randomUUID(); uploads.set(id, { path: entry.path, parts: new Map() });
        res.setHeader('content-type', 'application/xml'); res.end(`<InitiateMultipartUploadResult><Bucket>fixture</Bucket><Key>${entry.path}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); return;
      }
      const id = url.searchParams.get('uploadId'), upload = uploads.get(id);
      if (!upload || upload.path !== entry.path) return reject(404, 'NoSuchUpload');
      if (req.method === 'DELETE') { uploads.delete(id); res.writeHead(204); res.end(); return; }
      if (req.method === 'PUT') {
        const checksum = crypto.createHash('sha256').update(body).digest('base64');
        assert.equal(req.headers['x-amz-checksum-sha256'], checksum);
        upload.parts.set(Number(url.searchParams.get('partNumber')), body);
        res.setHeader('ETag', '"' + crypto.createHash('md5').update(body).digest('hex') + '"'); res.end(); return;
      }
      if (req.method === 'POST') {
        const parts = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]);
        assert(parts.length); for (const [index, part] of parts.slice(0, -1)) assert(part.length >= 5 * 1024 ** 2, 'Non-final S3 part must be at least 5 MiB: ' + index);
        const content = Buffer.concat(parts.map(([,part]) => part)); objects.set(entry.path, content); completed.push({ path: entry.path, body: content }); uploads.delete(id);
        res.setHeader('content-type', 'application/xml'); res.end(`<CompleteMultipartUploadResult><Location>http://localhost</Location><Bucket>fixture</Bucket><Key>${entry.path}</Key><ETag>"complete"</ETag></CompleteMultipartUploadResult>`); return;
      }
      reject(400, 'InvalidRequest');
    } catch { reject(500, 'FixtureAssertionFailed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { uploads, objects, requests, completed, url: 'http://127.0.0.1:' + server.address().port,
    async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}

module.exports = { s3Receiver };
