'use strict';

const https = require('node:https');
const { Agent, fetch: fetchPinned } = require('undici');
const { resolveReviewAddress, reviewUrl } = require('./review-http');

async function downloadReference(value, { signal, maxBytes }, dependencies = {}) {
  const url = reviewUrl(value);
  const address = await (dependencies.resolve || resolveReviewAddress)(url, signal);
  return new Promise((resolve, reject) => {
    const request = (dependencies.request || https.request)(url, {
      method: 'GET', signal, agent: false, autoSelectFamily: false, family: address.family,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: { accept: 'application/json, application/octet-stream', 'user-agent': 'sub2api-fingerpoint' }
    }, async response => {
      try {
        if (response.statusCode !== 200 || Number(response.headers['content-length'] || 0) > maxBytes) throw new Error('FINGERPOINT_DOWNLOAD_FAILED');
        const chunks = []; let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          if (length > maxBytes) throw new Error('FINGERPOINT_DATA_TOO_LARGE');
          chunks.push(chunk);
        }
        resolve(Buffer.concat(chunks, length));
      } catch (error) { response.destroy(); reject(error); }
    });
    request.once('error', reject);
    request.end();
  });
}

// The official SDK runs in its own worker; only its configured model endpoint can receive credentials.
function securedModelFetch(endpoint, jobSignal, dependencies = {}) {
  const agents = new Set();
  const expected = reviewUrl(endpoint).href;
  return {
    async fetch(input, options = {}) {
      const url = reviewUrl(String(input));
      if (url.href !== expected || options.method !== 'POST') throw new Error('FINGERPOINT_ENDPOINT_REJECTED');
      const signal = options.signal ? AbortSignal.any([jobSignal, options.signal]) : jobSignal;
      const address = await (dependencies.resolve || resolveReviewAddress)(url, signal);
      const agent = new Agent({ connect: { autoSelectFamily: false, family: address.family, lookup: (_host, _options, callback) => callback(null, address.address, address.family) } });
      agents.add(agent);
      const release = () => { agents.delete(agent); agent.destroy().catch(() => {}); };
      try {
        const response = await (dependencies.fetch || fetchPinned)(url, { ...options, dispatcher: agent, signal, redirect: 'error' });
        const maxBytes = 2 * 1024 * 1024;
        if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('FINGERPOINT_RESPONSE_TOO_LARGE');
        if (!response.body) { release(); return response; }
        const reader = response.body.getReader(); let length = 0;
        const body = new ReadableStream({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) { controller.close(); release(); return; }
              length += chunk.value.byteLength;
              if (length > maxBytes) throw new Error('FINGERPOINT_RESPONSE_TOO_LARGE');
              controller.enqueue(chunk.value);
            } catch (error) { controller.error(error); await reader.cancel().catch(() => {}); release(); }
          },
          async cancel() { await reader.cancel().catch(() => {}); release(); }
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) { release(); throw error; }
    },
    async close() { await Promise.allSettled([...agents].map(agent => agent.destroy())); agents.clear(); }
  };
}

module.exports = { downloadReference, securedModelFetch };
