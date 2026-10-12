'use strict';

const { setTimeout: delay } = require('timers/promises');
const crypto = require('crypto');
const { ReviewError, requestReviewJson, reviewUrl } = require('./review-http');

const errorReasons = {
  REVIEW_TIMEOUT: '视觉审核超时，无法判定',
  REVIEW_URL_UNSAFE: '审核 API 地址不安全或解析到受限网络，无法判定',
  REVIEW_HTTP_ERROR: '视觉审核服务暂不可用，无法判定',
  REVIEW_RESPONSE_TOO_LARGE: '视觉审核响应超过大小限制，无法判定',
  REVIEW_RESPONSE_INVALID: '视觉审核响应格式无效，无法判定',
  REVIEW_TASK_MISMATCH: '视觉审核任务或基准不匹配，无法判定',
  REVIEW_NO_VERDICT: '视觉审核没有返回可信结论，无法判定',
  REVIEW_INPUT_INVALID: '作品内容为空，无法送审',
  REVIEW_INPUT_TOO_LARGE: '作品超过 1 MB 的送审上限，无法判定',
  REVIEW_KEY_UNREADABLE: '审核专用 Key 无法读取，请由管理员重新配置',
  REVIEW_NETWORK_ERROR: '无法连接视觉审核服务，无法判定'
};

function prepareReviewHtml(source) {
  const html = String(source ?? '');
  if (Buffer.byteLength(html) > 1024 * 1024) throw new ReviewError('REVIEW_INPUT_TOO_LARGE');
  if (!html.trim()) throw new ReviewError('REVIEW_INPUT_INVALID');
  const svg = html.trim().replace(/^<\?xml\s+[^?]*\?>\s*/i, '');
  if (/^<svg(?:\s|>)/i.test(svg) && /<\/svg>\s*$/i.test(svg)) {
    const wrapped = `<!doctype html><html><head><meta charset="utf-8"></head><body>${svg}</body></html>`;
    if (Buffer.byteLength(wrapped) > 1024 * 1024) throw new ReviewError('REVIEW_INPUT_TOO_LARGE');
    return wrapped;
  }
  // Forward source as data; the external reviewer owns rendering and content policy.
  return html;
}

function reviewFailure(visual, code, durationMs = 0, httpStatus = null) {
  const knownCode = Object.hasOwn(errorReasons, code) ? code : 'REVIEW_NETWORK_ERROR';
  return {
    protocol: visual.protocol,
    decision_mode: visual.decision_mode,
    status: 'unknown',
    state: 'failed',
    error_code: knownCode,
    reason: errorReasons[knownCode],
    duration_ms: Math.max(0, durationMs),
    ...(knownCode === 'REVIEW_HTTP_ERROR' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
      ? { http_status: httpStatus } : {})
  };
}

class VisualReviewer {
  constructor({ request = requestReviewJson, sleep = (ms, signal) => delay(ms, undefined, { signal }), now = Date.now, logger = console } = {}) {
    this.request = request;
    this.sleep = sleep;
    this.now = now;
    this.logger = logger;
  }

  async review({ visual, html, apiKey, runId }) {
    const started = this.now();
    const controller = new AbortController();
    const deadline = started + visual.timeout_seconds * 1000;
    const taskKey = `degradation-review-${runId}-${crypto.randomUUID()}`;
    const timer = setTimeout(() => controller.abort(), visual.timeout_seconds * 1000);
    let stage = 'prepare';
    const remaining = () => {
      const milliseconds = deadline - this.now();
      if (milliseconds <= 0 || controller.signal.aborted) throw new ReviewError('REVIEW_TIMEOUT');
      return milliseconds;
    };
    const request = async (method, url, body) => {
      remaining();
      stage = method === 'POST' ? 'submit' : 'poll';
      // The absolute deadline also applies to DNS, polling and response reads.
      let abort;
      try {
        return await Promise.race([
          this.request(url, { method, body, apiKey, signal: controller.signal, taskKey }),
          new Promise((_resolve, reject) => {
            abort = () => reject(new ReviewError('REVIEW_TIMEOUT'));
            controller.signal.addEventListener('abort', abort, { once: true });
            if (controller.signal.aborted) abort();
          })
        ]);
      } finally { controller.signal.removeEventListener('abort', abort); }
    };
    try {
      const reviewHtml = prepareReviewHtml(html);
      const base = reviewUrl(visual.api_url).href.replace(/\/$/, '');
      let task = await request('POST', base, {
        benchmark: visual.benchmark,
        html: reviewHtml,
        ...(visual.protocol === 'html_review' && visual.model ? { model: visual.model } : {}),
        ...(visual.protocol === 'html_review' && visual.instructions ? { instructions: visual.instructions } : {})
      });
      if (visual.protocol === 'manxue') {
        const id = task.id;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(id)) throw new ReviewError('REVIEW_RESPONSE_INVALID');
        while (true) {
          remaining();
          if (task.id !== id || (task.benchmark != null && task.benchmark !== visual.benchmark)) throw new ReviewError('REVIEW_TASK_MISMATCH');
          if (task.status === 'succeeded') {
            if (task.benchmark !== visual.benchmark) throw new ReviewError('REVIEW_TASK_MISMATCH');
            break;
          }
          if (task.status != null && !['queued', 'pending', 'running'].includes(task.status)) throw new ReviewError('REVIEW_NO_VERDICT');
          await this.sleep(Math.min(visual.poll_interval_seconds * 1000, remaining()), controller.signal);
          task = await request('GET', `${base}/${encodeURIComponent(id)}`);
        }
      } else if ((task.benchmark != null && task.benchmark !== visual.benchmark)
        || (task.status != null && task.status !== 'succeeded')) {
        throw new ReviewError('REVIEW_NO_VERDICT');
      }
      remaining();
      const quality = visual.protocol === 'manxue' ? task.assessment?.quality : (task.assessment?.quality ?? task.quality);
      if (!['normal', 'degraded'].includes(quality)) throw new ReviewError('REVIEW_NO_VERDICT');
      return {
        protocol: visual.protocol,
        decision_mode: visual.decision_mode,
        status: quality,
        state: 'completed',
        reason: quality === 'normal' ? '视觉审核判定为正常' : '视觉审核判定为疑似降智',
        duration_ms: Math.max(0, this.now() - started)
      };
    } catch (error) {
      const failure = reviewFailure(visual, controller.signal.aborted ? 'REVIEW_TIMEOUT' : error.code,
        this.now() - started, error.httpStatus);
      this.logger.warn(JSON.stringify({
        event: 'visual_review_failed', runId, protocol: visual.protocol, stage, code: failure.error_code,
        ...(failure.http_status ? { httpStatus: failure.http_status } : {})
      }));
      return failure;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

function combineReview(deterministic, visual, review) {
  let status = review.status;
  if (review.status !== 'unknown' && visual.decision_mode === 'both') {
    if (review.status === 'degraded' || deterministic.status === 'degraded') status = 'degraded';
    else status = deterministic.status === 'normal' ? 'normal' : 'unknown';
  }
  const labels = { normal: '正常', degraded: '疑似降智', unknown: '无法判定' };
  return {
    ...deterministic,
    quality: status,
    status,
    reason: visual.decision_mode === 'both'
      ? `${review.reason}；本地规则${labels[deterministic.status]}；综合判定为${labels[status]}`
      : review.reason,
    source: visual.decision_mode === 'both' ? 'rules_and_visual' : 'visual_review',
    validationResult: { ...deterministic.validationResult, local_status: deterministic.status, visual: review }
  };
}

module.exports = { VisualReviewer, combineReview, prepareReviewHtml, reviewFailure };
