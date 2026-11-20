'use strict';

const { responseText, extractHtml } = require('./detection-runner');
const { requestReviewEvents, ReviewError } = require('./review-http');
const { prepareReviewHtml } = require('./visual-review');
const { PELICAN_METHOD, PELICAN_PROMPT } = require('./provider-config');
const { withModelRecovery } = require('./model-request-recovery');
const { isSafePreconnectError, canRecoverTransport, isPermanentModelFailure, isTransientModelFailure, isUncertainModelFailure } = require('./sub2api-client');

function generationFailure(terminal) {
  const error = new ReviewError(terminal ? 'PROVIDER_GENERATION_FAILED' : 'PROVIDER_GENERATION_INCOMPLETE');
  const detail = terminal?.response?.error || terminal?.error || terminal;
  const code = detail?.code || detail?.type;
  const message = typeof detail === 'string' ? detail : detail?.message;
  error.diagnostic = { provider_code: code, provider_message: message };
  const failed = ['error', 'response.failed'].includes(terminal?.type);
  error.recoverable = !terminal || failed && isTransientModelFailure(code, message);
  error.outcomeUnknown = !terminal || failed && isUncertainModelFailure(code, message);
  return error;
}

function recoverableFailure(error, signal, timedOut) {
  if (signal.aborted) return error;
  error.diagnostic ||= { provider_code: error.cause?.code || error.code };
  const code = error.diagnostic?.provider_code, message = error.diagnostic?.provider_message;
  error.details = { upstreamStatus: error.httpStatus, upstreamCode: code };
  if (error.httpStatus) {
    error.retryable = false;
    error.responseStarted = true;
    error.recoverable = [429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(error.httpStatus) &&
      (isTransientModelFailure(code, message) || !code && !isPermanentModelFailure(code, message));
    error.outcomeUnknown = isUncertainModelFailure(code, message) || [502, 504, 520, 521, 522, 523, 524].includes(error.httpStatus);
  } else if (error.recoverable == null) {
    const safe = error.responseStarted !== true && isSafePreconnectError(error);
    error.retryable = safe;
    error.recoverable = !safe && (timedOut || canRecoverTransport(error));
    error.outcomeUnknown = error.recoverable;
  }
  return error;
}

async function generatePelican({ snapshot, key, signal, maxResponseBytes, taskKey, config = {},
  deadline = Infinity, ensureCurrent: check, onAttempts, runId }, request = requestReviewEvents, dependencies = {}) {
  const { now = Date.now } = dependencies;
  const started = now();
  const budget = snapshot.timeout_seconds * 1000 || config.requestTimeoutMs || 30 * 60 * 1000;
  const expires = Math.min(deadline, started + budget, started + (config.recoveryTimeoutMs || budget));
  const ensureCurrent = () => {
    signal.throwIfAborted();
    check?.();
    if (now() >= expires) throw new ReviewError('REVIEW_TIMEOUT');
  };
  const body = {
    model: snapshot.model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: snapshot.prompt }] }],
    stream: true,
    reasoning: { effort: snapshot.reasoning_effort },
    ...(snapshot.service_tier ? { service_tier: snapshot.service_tier } : {})
  };
  const endpoint = snapshot.target_url.replace(/\/+$/, '') + '/responses';
  return withModelRecovery(async ({ timeoutMs, sessionId, recoveryAttempt }) => {
    const attemptStarted = now();
    let firstTokenMs = null, terminal = null, deltas = '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      try {
        await request(endpoint, { method: 'POST', body, apiKey: key, secrets: [key],
          signal: AbortSignal.any([signal, controller.signal]), maxResponseBytes, sessionId,
          taskKey: taskKey && recoveryAttempt ? `${taskKey}-recovery-${recoveryAttempt}` : taskKey }, event => {
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            if (firstTokenMs == null && event.delta) firstTokenMs = now() - attemptStarted;
            deltas += event.delta;
          }
          if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled', 'error'].includes(event.type)) {
            terminal = event;
            return false;
          }
        });
      } catch (error) {
        // A socket failure after confirmed completion must not cause another paid inference.
        if (terminal?.type !== 'response.completed' || terminal.response?.status !== 'completed' || terminal.response.error || !canRecoverTransport(error)) throw error;
      }
      ensureCurrent();
      if (terminal?.type !== 'response.completed' || terminal.response?.status !== 'completed' || terminal.response.error) {
        throw generationFailure(terminal);
      }
      const payload = terminal.response;
      const html = extractHtml(responseText(payload, 'responses') || deltas);
      // Validate only a completed attempt; abandoned fragments never enter the next request.
      prepareReviewHtml(html);
      const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
      return {
        html, duration_ms: now() - attemptStarted, first_token_ms: firstTokenMs,
        input_tokens: count(payload.usage?.input_tokens), output_tokens: count(payload.usage?.output_tokens)
      };
    } catch (error) {
      throw recoverableFailure(error, signal, controller.signal.aborted);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }, { config, context: { signal, onAttempts, runId }, ensureCurrent, withSession: true, requestTimeoutMs: budget,
    deadline: expires, ...dependencies });
}

module.exports = { generatePelican, PELICAN_METHOD, PELICAN_PROMPT };
