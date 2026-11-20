'use strict';

const crypto = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const RECOVERY_DELAYS_MS = [10000, 30000, 60000];

async function withModelRecovery(call, { config, context = {}, ensureCurrent, withSession = false,
  requestTimeoutMs = config.requestTimeoutMs, deadline = Infinity,
  now = Date.now, random = Math.random, sleep = (ms, signal) => wait(ms, undefined, { signal }) }) {
  const configuredBudget = Number(requestTimeoutMs);
  const budgetMs = Number.isFinite(configuredBudget) && configuredBudget > 0 ? configuredBudget : 30 * 60 * 1000;
  const recoveryLimit = Math.max(0, Math.min(3, config.recoveryRetries ?? 2));
  const recoveryDeadline = Math.min(deadline, now() + (config.recoveryTimeoutMs || budgetMs));
  const initialDeadline = Math.min(now() + budgetMs, recoveryDeadline);
  let retryAttempts = 0, recoveryAttempts = 0, unknownRecoveries = 0, lastError = null;
  let sessionId = withSession ? crypto.randomUUID() : null;
  const attempts = [];
  const record = () => context.onAttempts?.(attempts);
  const annotate = error => {
    if (error && typeof error === 'object') Object.assign(error, { retryAttempts, recoveryAttempts });
    return error;
  };

  while (true) {
    ensureCurrent();
    const remainingMs = (recoveryAttempts > 0 ? recoveryDeadline : initialDeadline) - now();
    if (remainingMs <= 0 && lastError) throw annotate(lastError);
    const attempt = { number: attempts.length + 1, kind: attempts.length === 0 ? 'initial' : attempts.at(-1).next_action,
      started_at: now(), state: 'running' };
    attempts.push(attempt);
    record();
    try {
      const payload = await call({ timeoutMs: Math.max(1, Math.min(budgetMs, remainingMs)), sessionId, recoveryAttempt: recoveryAttempts });
      ensureCurrent();
      Object.assign(attempt, { state: 'completed', finished_at: now() });
      record();
      if (retryAttempts > 0 || recoveryAttempts > 0) {
        console.info(JSON.stringify({ event: 'model_request_retry_succeeded', runId: context.runId, monitorId: context.monitorId,
          retryAttempts, recoveryAttempts }));
      }
      return payload;
    } catch (error) {
      Object.assign(attempt, { state: 'failed', finished_at: now(), code: error.code || 'UNKNOWN',
        upstream_status: error.details?.upstreamStatus, upstream_code: error.details?.upstreamCode,
        outcome_unknown: Boolean(error.outcomeUnknown) });
      record();
      ensureCurrent();
      const retryable = error?.retryable === true && error?.responseStarted !== true;
      const recoverable = !retryable && error?.recoverable === true && recoveryAttempts < recoveryLimit &&
        (!error.outcomeUnknown || unknownRecoveries < 1);
      const baseDelay = retryable ? RETRY_DELAYS_MS[retryAttempts]
        : recoverable ? Math.max(error.outcomeUnknown ? 30000 : 0, RECOVERY_DELAYS_MS[recoveryAttempts]) : NaN;
      const delayMs = Math.max(baseDelay + Math.floor(random() * Math.min(1000, baseDelay * 0.2)), error.retryAfterMs || 0);
      const activeDeadline = recoverable || recoveryAttempts > 0 ? recoveryDeadline : initialDeadline;
      if ((!retryable && !recoverable) || !Number.isFinite(delayMs) || now() + delayMs >= activeDeadline) throw annotate(error);

      lastError = error;
      if (retryable) retryAttempts += 1;
      else {
        recoveryAttempts += 1;
        if (error.outcomeUnknown) unknownRecoveries += 1;
        // A paid recovery starts a new session; safe reconnects keep its identity.
        if (sessionId) sessionId = crypto.randomUUID();
      }
      attempt.next_action = retryable ? 'retry' : 'recovery';
      attempt.delay_ms = delayMs;
      record();
      console.warn(JSON.stringify({ event: retryable ? 'model_request_retry' : 'model_request_recovery',
        runId: context.runId, monitorId: context.monitorId, retryAttempt: retryAttempts, recoveryAttempt: recoveryAttempts,
        maxRetries: RETRY_DELAYS_MS.length, delayMs, code: error.code || 'UNKNOWN' }));
      try { await sleep(delayMs, context.signal); }
      catch (error) { ensureCurrent(); throw error; }
    }
  }
}

module.exports = { withModelRecovery, MODEL_REQUEST_RETRY_DELAYS_MS: RETRY_DELAYS_MS, MODEL_RECOVERY_DELAYS_MS: RECOVERY_DELAYS_MS };
