'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const { AppError } = require('./errors');

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return part?.text || part?.output_text || part?.content || '';
  }).join('');
}

function responseText(payload, api) {
  if (api === 'responses') {
    if (typeof payload?.output_text === 'string') return payload.output_text;
    return (payload?.output || []).flatMap((item) => item?.content || [])
      .map((part) => part?.text || part?.output_text || '')
      .join('');
  }
  if (api === 'chat_completions') {
    return contentText(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text);
  }
  if (api === 'anthropic_messages') return contentText(payload?.content);
  if (api === 'gemini_generate_content') {
    return (payload?.candidates || []).flatMap((candidate) => candidate?.content?.parts || [])
      .map((part) => part?.text || '')
      .join('');
  }
  return '';
}

function stripFence(value, language = '') {
  const text = String(value || '').trim();
  const match = text.match(/^```([^\n]*)\n([\s\S]*?)\n```\s*$/);
  if (!match) return text;
  if (language && match[1].trim() && !match[1].toLowerCase().includes(language.toLowerCase())) {
    return text;
  }
  return match[2].trim();
}

function extractHtml(value) {
  const text = stripFence(value, 'html');
  const doctype = text.search(/<!doctype\s+html/i);
  const htmlStart = text.search(/<html(?:\s|>)/i);
  const start = doctype >= 0 ? doctype : htmlStart;
  if (start < 0) return text;
  const endMatch = /<\/html\s*>/ig;
  let match;
  let end = -1;
  while ((match = endMatch.exec(text))) end = match.index + match[0].length;
  return text.slice(start, end > start ? end : undefined).trim();
}

function parseJsonText(value) {
  const text = stripFence(value, 'json');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new AppError('FILE_RESPONSE_INVALID', '文件检测响应不是有效的 Base64 JSON', { status: 502 });
  }
}

function extensionForMime(mime) {
  const value = String(mime || '').split(';')[0].trim().toLowerCase();
  return ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/html': '.html',
    'text/plain': '.txt',
    'application/json': '.json'
  })[value] || '.bin';
}

function safeFilename(value, fallback, mime) {
  const basename = path.basename(String(value || fallback || 'artifact'))
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120) || 'artifact';
  return path.extname(basename) ? basename : `${basename}${extensionForMime(mime)}`;
}

function decodeBase64(value, maxBytes) {
  const raw = String(value || '').replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
  if (!raw || !/^[a-z0-9+/=_-]+$/i.test(raw)) {
    throw new AppError('ARTIFACT_BASE64_INVALID', '模型返回的文件不是有效 Base64', { status: 502 });
  }
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes) {
    throw new AppError('ARTIFACT_SIZE_INVALID', '模型返回的文件为空或超过大小限制', { status: 502 });
  }
  return buffer;
}

function responseImage(payload) {
  const generated = payload?.data?.[0] || payload?.images?.[0];
  if (generated) {
    return {
      base64: generated.b64_json || generated.base64 || generated.image_base64,
      url: generated.url,
      mime: generated.mime_type || generated.mimeType,
      filename: generated.filename
    };
  }

  const responseItem = (payload?.output || []).find((item) =>
    item?.type === 'image_generation_call' && (item.result || item.b64_json)
  );
  if (responseItem) {
    return {
      base64: responseItem.result || responseItem.b64_json,
      mime: responseItem.mime_type || responseItem.mimeType,
      filename: responseItem.filename
    };
  }

  const geminiPart = (payload?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .find((part) => part?.inlineData?.data || part?.inline_data?.data);
  const inline = geminiPart?.inlineData || geminiPart?.inline_data;
  if (inline) {
    return {
      base64: inline.data,
      mime: inline.mimeType || inline.mime_type,
      filename: inline.filename
    };
  }
  return null;
}

function imageDimensions(buffer, mime) {
  if (mime === 'image/png' && buffer.length >= 24 && buffer.subarray(1, 4).toString() === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === 'image/gif' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mime === 'image/jpeg' && buffer.length >= 4) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (mime === 'image/webp' && buffer.length >= 30 && buffer.subarray(0, 4).toString() === 'RIFF') {
    const type = buffer.subarray(12, 16).toString();
    if (type === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3)
      };
    }
  }
  return null;
}

function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
      (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && [18, 19].includes(parts[1])) ||
      (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
      parts[0] >= 224;
  }
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') ||
    normalized.startsWith('ff') || normalized.startsWith('2001:db8:');
}

async function assertPublicHttps(url) {
  if (url.protocol !== 'https:') {
    throw new AppError('ARTIFACT_URL_UNSAFE', '远程产物必须使用 HTTPS', { status: 502 });
  }
  if (url.username || url.password) {
    throw new AppError('ARTIFACT_URL_UNSAFE', '远程产物地址不能包含凭据', { status: 502 });
  }
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new AppError('ARTIFACT_URL_UNSAFE', '远程产物地址解析到受限网络', { status: 502 });
  }
  return addresses;
}

async function readIncomingLimited(response, maxBytes) {
  const declared = Number(response.headers['content-length'] || 0);
  if (declared > maxBytes) {
    response.destroy();
    throw new AppError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应超过大小限制', { status: 502 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      response.destroy();
      throw new AppError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应超过大小限制', { status: 502 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function downloadPinnedHttps(url, address, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const request = https.request(url, {
      method: 'GET',
      headers: { accept: 'image/*,application/octet-stream;q=0.8' },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
    }, async (response) => {
      try {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          throw new AppError('ARTIFACT_DOWNLOAD_FAILED', '远程产物下载失败', { status: 502 });
        }
        const buffer = await readIncomingLimited(response, maxBytes);
        const mime = String(response.headers['content-type'] || '')
          .split(';')[0]
          .trim() || 'application/octet-stream';
        resolve({ buffer, mime });
      } catch (error) {
        reject(error);
      }
    });
    request.setTimeout(timeoutMs, () => {
      timedOut = true;
      request.destroy();
    });
    request.on('error', (error) => {
      reject(timedOut
        ? new AppError('ARTIFACT_DOWNLOAD_TIMEOUT', '远程产物下载超时', { status: 504 })
        : new AppError('ARTIFACT_DOWNLOAD_FAILED', '远程产物下载失败', {
            status: 502,
            details: { cause: error.code || 'NETWORK_ERROR' }
          }));
    });
    request.end();
  });
}

function compilePattern(pattern, caseSensitive) {
  try {
    return new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch {
    throw new AppError('VALIDATION_PATTERN_INVALID', `检测规则不是有效正则表达式: ${pattern}`, {
      status: 500
    });
  }
}

function deterministicVerdict(test, output) {
  const validation = test.validation || {};
  const source = output.text != null ? String(output.text) : '';
  const bytes = output.buffer ? output.buffer.length : Buffer.byteLength(source);
  const failures = [];
  if (bytes < Number(validation.min_bytes || 1)) {
    failures.push(`输出仅 ${bytes} 字节，低于 ${validation.min_bytes || 1} 字节`);
  }
  for (const pattern of validation.required_patterns || []) {
    if (!compilePattern(pattern, validation.case_sensitive).test(source)) {
      failures.push(`缺少预期特征 ${pattern}`);
    }
  }
  for (const pattern of validation.forbidden_patterns || []) {
    if (compilePattern(pattern, validation.case_sensitive).test(source)) {
      failures.push(`出现禁止特征 ${pattern}`);
    }
  }
  if (test.output_type === 'html' && !/<html(?:\s|>)/i.test(source)) {
    failures.push('没有返回完整 HTML 文档');
  }
  if (test.output_type === 'image') {
    if (!String(output.mime || '').startsWith('image/')) failures.push('返回内容不是图片');
    const dimensions = output.buffer ? imageDimensions(output.buffer, output.mime) : null;
    if (!dimensions) failures.push('无法识别图片尺寸');
    if (dimensions && validation.min_width && dimensions.width < validation.min_width) {
      failures.push(`图片宽度 ${dimensions.width}px 低于 ${validation.min_width}px`);
    }
    if (dimensions && validation.min_height && dimensions.height < validation.min_height) {
      failures.push(`图片高度 ${dimensions.height}px 低于 ${validation.min_height}px`);
    }
  }
  if (failures.length > 0) {
    return {
      quality: 'degraded',
      status: 'degraded',
      reason: `规则判定为疑似降智：${failures.slice(0, 3).join('；')}；单次结果不能证明模型身份或整体能力`,
      source: 'configured_validation'
    };
  }
  return {
    quality: 'normal',
    status: 'normal',
    reason: '规则判定为正常；单次结果不能证明模型身份或整体能力',
    source: 'configured_validation'
  };
}

class DetectionRunner {
  constructor({ config, store, sub2api, vault }) {
    this.config = config;
    this.store = store;
    this.sub2api = sub2api;
    this.vault = vault;
  }

  async callModel(test, apiKey) {
    if (this.config.demoMode) {
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
        *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden}
        body{display:grid;place-items:center;background:#c8edf4;font-family:system-ui;color:#18343a}
        .scene{position:relative;width:100%;height:100%;background:linear-gradient(#b9e9f5 0 60%,#87bd88 60% 72%,#344b57 72%)}
        .sun{position:absolute;right:12%;top:10%;width:72px;height:72px;border-radius:50%;background:#ffe29a}
        .bike{position:absolute;left:50%;top:58%;width:420px;height:180px;transform:translate(-50%,-50%);animation:bob 1.1s ease-in-out infinite}
        .wheel{position:absolute;bottom:0;width:120px;height:120px;border:9px solid #263d4a;border-radius:50%;animation:spin 1.1s linear infinite}
        .wheel:before,.wheel:after{content:"";position:absolute;background:#8da0a6;left:50%;top:5%;width:2px;height:90%;transform-origin:center}
        .wheel:after{transform:rotate(90deg)}.wheel:last-child{right:0}.frame{position:absolute;left:59px;bottom:55px;width:300px;height:10px;background:#e56b4d;transform:rotate(-2deg)}
        .bird{position:absolute;left:150px;bottom:80px;width:130px;height:95px;border:5px solid #263d4a;border-radius:55% 45%;background:#fff8df;transform:rotate(-6deg)}
        .bird:before{content:"";position:absolute;left:-72px;top:5px;width:85px;height:34px;background:#f3a84d;clip-path:polygon(0 45%,100% 0,100% 100%)}
        .bird:after{content:"";position:absolute;right:30px;top:22px;width:13px;height:13px;border-radius:50%;background:#263d4a}
        @keyframes spin{to{transform:rotate(360deg)}}@keyframes bob{50%{transform:translate(-50%,-54%)}}
      </style></head><body><div class="scene"><div class="sun"></div><div class="bike"><div class="wheel"></div><div class="wheel"></div><div class="frame"></div><div class="bird"></div></div></div></body></html>`;
      const text = test.output_type === 'html' ? html : '1161';
      if (test.api === 'responses') return { output_text: text };
      if (test.api === 'chat_completions') return { choices: [{ message: { content: text } }] };
      if (test.api === 'anthropic_messages') return { content: [{ type: 'text', text }] };
      if (test.api === 'gemini_generate_content') {
        return { candidates: [{ content: { parts: [{ text }] } }] };
      }
    }
    const common = { timeoutMs: this.config.requestTimeoutMs, maxBytes: this.config.maxResponseBytes };
    if (test.api === 'responses') {
      const body = {
        model: test.model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: test.prompt }] }],
        stream: false,
        max_output_tokens: test.max_output_tokens
      };
      if (test.reasoning_effort && test.reasoning_effort !== 'none') {
        body.reasoning = { effort: test.reasoning_effort };
      }
      if (test.output_type === 'image') body.tools = [{ type: 'image_generation' }];
      return this.sub2api.gatewayJson('/v1/responses', apiKey, body, common);
    }
    if (test.api === 'chat_completions') {
      return this.sub2api.gatewayJson('/v1/chat/completions', apiKey, {
        model: test.model,
        messages: [{ role: 'user', content: test.prompt }],
        stream: false,
        max_tokens: test.max_output_tokens,
        ...(test.reasoning_effort && test.reasoning_effort !== 'none'
          ? { reasoning_effort: test.reasoning_effort }
          : {})
      }, common);
    }
    if (test.api === 'anthropic_messages') {
      return this.sub2api.gatewayJson('/v1/messages', apiKey, {
        model: test.model,
        max_tokens: test.max_output_tokens,
        messages: [{ role: 'user', content: test.prompt }]
      }, {
        ...common,
        headers: { 'anthropic-version': '2023-06-01' }
      });
    }
    if (test.api === 'gemini_generate_content') {
      const model = encodeURIComponent(test.model.replace(/^models\//i, ''));
      return this.sub2api.gatewayJson(`/v1beta/models/${model}:generateContent`, apiKey, {
        contents: [{ role: 'user', parts: [{ text: test.prompt }] }],
        generationConfig: {
          maxOutputTokens: test.max_output_tokens,
          ...(test.output_type === 'image' ? { responseModalities: ['TEXT', 'IMAGE'] } : {})
        }
      }, common);
    }
    if (test.api === 'images_generations') {
      return this.sub2api.gatewayJson('/v1/images/generations', apiKey, {
        model: test.model,
        prompt: test.prompt,
        response_format: 'b64_json'
      }, common);
    }
    throw new AppError('TEST_API_UNSUPPORTED', `不支持的检测协议: ${test.api}`, { status: 500 });
  }

  async remoteArtifact(urlValue) {
    let url;
    try {
      url = new URL(String(urlValue));
    } catch {
      throw new AppError('ARTIFACT_URL_INVALID', '远程产物地址无效', { status: 502 });
    }
    const addresses = await assertPublicHttps(url);
    return downloadPinnedHttps(
      url,
      addresses[0],
      Math.min(this.config.requestTimeoutMs, 120000),
      this.config.maxResponseBytes
    );
  }

  async normalizeOutput(test, payload) {
    if (test.output_type === 'image') {
      const item = responseImage(payload) || {};
      const dataValue = item.base64;
      if (dataValue) {
        const mimeMatch = String(dataValue).match(/^data:([^;]+);base64,/i);
        const mime = mimeMatch?.[1] || item.mime || test.mime_type || 'image/png';
        return {
          buffer: decodeBase64(dataValue, this.config.maxResponseBytes),
          mime,
          filename: safeFilename(item.filename, 'result', mime)
        };
      }
      if (item.url) {
        const remote = await this.remoteArtifact(item.url);
        return {
          ...remote,
          filename: safeFilename('', 'result', remote.mime)
        };
      }
      throw new AppError('IMAGE_RESPONSE_EMPTY', '图片接口没有返回可用图片', { status: 502 });
    }

    const text = responseText(payload, test.api).trim();
    if (!text) throw new AppError('MODEL_RESPONSE_EMPTY', '模型没有返回文本内容', { status: 502 });
    if (test.output_type === 'html') return { text: extractHtml(text), mime: 'text/html' };
    if (test.output_type === 'file') {
      const file = parseJsonText(text);
      const mime = String(file.mime_type || test.mime_type || 'application/octet-stream').slice(0, 200);
      return {
        buffer: decodeBase64(file.base64 || file.data, this.config.maxResponseBytes),
        mime,
        filename: safeFilename(file.filename, 'result', mime)
      };
    }
    return { text: stripFence(text), mime: 'text/plain' };
  }

  async classify(test, output, deterministic) {
    return deterministic;
  }

  async persistArtifact(runId, output) {
    if (!output.buffer) return null;
    const filename = safeFilename(output.filename, `result-${runId}`, output.mime);
    const storedName = `${runId}-${crypto.randomBytes(8).toString('hex')}${path.extname(filename)}`;
    const target = path.resolve(this.config.artifactDir, storedName);
    if (!target.startsWith(`${path.resolve(this.config.artifactDir)}${path.sep}`)) {
      throw new AppError('ARTIFACT_PATH_INVALID', '产物路径无效', { status: 500 });
    }
    const temporary = `${target}.tmp-${process.pid}`;
    try {
      await fs.promises.writeFile(temporary, output.buffer, { flag: 'wx' });
      await fs.promises.rename(temporary, target);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return { path: target, name: filename, mime: output.mime };
  }

  async execute(runId, monitor) {
    const run = this.store.markRunRunning(runId);
    const currentMonitor = this.store.getMonitorById(monitor.id);
    const test = currentMonitor && this.store.getPlatformTest(currentMonitor.platform);
    if (!currentMonitor?.enabled || !test) {
      this.store.failRun(runId, {
        reason: `平台 ${monitor.platform} 已不在检测配置中`,
        errorCode: 'PLATFORM_CONFIG_REMOVED'
      }, this.store.nextScheduledAt());
      return this.store.getRun(runId);
    }
    try {
      let apiKey;
      try {
        apiKey = this.config.demoMode
          ? 'demo-only-not-a-real-api-key'
          : this.vault.decrypt(currentMonitor.group_id, currentMonitor.key_cipher);
      } catch (error) {
        this.store.setMonitorEnabled(currentMonitor.user_id, currentMonitor.group_id, false);
        throw error;
      }
      if (!apiKey || !currentMonitor.key_fingerprint) {
        this.store.setMonitorEnabled(currentMonitor.user_id, currentMonitor.group_id, false);
        throw new AppError(
          'DETECTION_KEY_NOT_CONFIGURED',
          `分组 ${currentMonitor.group_name} 未配置服务专用 Key`,
          { status: 409 }
        );
      }
      const payload = await this.callModel(test, apiKey);
      const output = await this.normalizeOutput(test, payload);
      const deterministic = deterministicVerdict(test, output);
      const verdict = await this.classify(test, output, deterministic);
      const artifact = await this.persistArtifact(runId, output);
      const previewToken = ['html', 'image', 'file'].includes(test.output_type)
        ? crypto.randomBytes(32).toString('base64url')
        : null;
      const completed = this.store.completeRun(runId, {
        ...verdict,
        outputText: output.text || null,
        artifactPath: artifact?.path || null,
        artifactName: artifact?.name || null,
        artifactMime: artifact?.mime || output.mime || null,
        previewToken
      }, this.store.nextScheduledAt());
      const stalePaths = this.store.pruneRuns(currentMonitor.id, this.config.historyLimit);
      const artifactRoot = path.resolve(this.config.artifactDir);
      await Promise.all(stalePaths.map((filename) => {
        const resolved = path.resolve(filename);
        if (!resolved.startsWith(`${artifactRoot}${path.sep}`)) return null;
        return fs.promises.rm(resolved, { force: true }).catch(() => {});
      }));
      return completed;
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError('DETECTION_FAILED', '检测执行失败', { status: 502 });
      return this.store.failRun(runId, {
        reason: `${appError.message}，本次不计入有效结果`,
        source: 'request_error',
        errorCode: appError.code
      }, this.store.nextScheduledAt());
    } finally {
      if (run?.prompt) run.prompt = null;
    }
  }
}

module.exports = {
  DetectionRunner,
  assertPublicHttps,
  contentText,
  decodeBase64,
  deterministicVerdict,
  extractHtml,
  imageDimensions,
  isPrivateAddress,
  parseJsonText,
  responseText,
  responseImage,
  safeFilename,
  stripFence
};
