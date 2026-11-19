'use strict';

const https = require('node:https');
const { StringDecoder } = require('node:string_decoder');
const { ReviewError, reviewUrl, resolveReviewAddress } = require('./review-http');

async function waitForTestLLM(value, { signal }, dependencies = {}) {
  const url = reviewUrl(value);
  const address = await resolveReviewAddress(url, signal, dependencies.lookup);
  return new Promise((resolve, reject) => {
    const request = (dependencies.request || https.request)(url, {
      method: 'GET', signal, agent: false, autoSelectFamily: false, family: address.family,
      headers: { accept: 'text/event-stream' },
      lookup: (_host, _options, callback) => callback(null, address.address, address.family)
    }, async response => {
      try {
        if (response.statusCode !== 200) throw new ReviewError('REVIEW_HTTP_ERROR', { httpStatus: response.statusCode });
        if (!String(response.headers['content-type']).startsWith('text/event-stream')) throw new Error('PROVIDER_RESPONSE_INVALID');
        const decoder = new StringDecoder('utf8');
        let pending = '';
        let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          if (length > 2 * 1024 * 1024) throw new ReviewError('REVIEW_RESPONSE_TOO_LARGE');
          pending += decoder.write(chunk);
          let match;
          while ((match = /\r?\n\r?\n/.exec(pending))) {
            const frame = pending.slice(0, match.index);
            pending = pending.slice(match.index + match[0].length);
            const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!payload) continue;
            let event;
            try { event = JSON.parse(payload); } catch { throw new Error('PROVIDER_RESPONSE_INVALID'); }
            if (event.step === 'error') throw new Error('PROVIDER_REMOTE_FAILED');
            if (event.step === 'done') { resolve(); response.destroy(); return; }
          }
          if (pending.length > 65536) throw new ReviewError('REVIEW_RESPONSE_TOO_LARGE');
        }
        throw new Error('PROVIDER_EVENTS_INTERRUPTED');
      } catch (error) { reject(error); response.destroy(); }
    });
    request.once('error', reject);
    request.end();
  });
}

module.exports = { waitForTestLLM };
