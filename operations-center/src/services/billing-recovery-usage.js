'use strict';

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null;
}

function observedTokens(entry) {
  const u = entry.observed_usage || {};
  const invalidCount = (value) => Object.entries(value).some(([key, field]) =>
    /(?:tokens|tokencount)$/i.test(key) ? count(field) == null :
      field && typeof field === 'object' && !Array.isArray(field) && invalidCount(field));
  const read = count(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ??
    u.cache_read_input_tokens ?? u.cache_read_tokens ?? u.cached_tokens ?? u.cachedContentTokenCount ?? u.cacheReadInputTokens ?? u.cacheReadInputTokenCount);
  const creation = count(u.input_tokens_details?.cache_write_tokens ?? u.prompt_tokens_details?.cache_write_tokens ??
    u.input_tokens_details?.cache_creation_tokens ?? u.prompt_tokens_details?.cache_creation_tokens ??
    u.cache_creation_input_tokens ?? u.cache_creation_tokens ?? u.cache_write_tokens ?? u.cache_write_input_tokens ?? u.cacheWriteInputTokens ?? u.cacheWriteInputTokenCount);
  const inclusive = count(u.prompt_tokens ?? u.promptTokenCount ??
    (u._recovery?.protocol === 'responses' || u.input_tokens_details ? u.input_tokens : null));
  const input = inclusive == null ? count(u.input_tokens ?? u.inputTokens ?? u.inputTokenCount) :
    count(inclusive - (read ?? 0) - (creation ?? 0));
  let output = count(u.output_tokens ?? u.completion_tokens ?? u.outputTokens ?? u.candidatesTokenCount ?? u.outputTokenCount);
  if (output != null && u.candidatesTokenCount != null) output += count(u.thoughtsTokenCount) ?? 0;
  const rawInput = count(u.input_tokens ?? u.prompt_tokens);
  const reasoning = count(u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens);
  const total = count(u.total_tokens);
  if (output != null && rawInput != null && reasoning > 0 && total > rawInput + output) {
    output += Math.min(reasoning, total - rawInput - output);
  }
  output = count(output);
  const media = [u.input_tokens_details?.image_tokens, u.prompt_tokens_details?.image_tokens,
    u.output_tokens_details?.image_tokens, u.completion_tokens_details?.image_tokens,
    u.input_tokens_details?.audio_tokens, u.output_tokens_details?.audio_tokens,
    u.prompt_tokens_details?.audio_tokens, u.completion_tokens_details?.audio_tokens,
    u.server_tool_use?.web_search_requests, u.server_tool_use?.web_fetch_requests];
  return { input_tokens: input, output_tokens: output,
    cache_creation_tokens: creation,
    cache_read_tokens: read,
    cache_creation_5m_tokens: count(u.cache_creation?.ephemeral_5m_input_tokens),
    cache_creation_1h_tokens: count(u.cache_creation?.ephemeral_1h_input_tokens),
    supported: !media.some(value => value != null && value !== 0),
    complete: u._recovery?.complete === true && u._recovery?.invalid_usage !== true &&
      !invalidCount(u) && input != null && output != null };
}

function requestIds(entry) {
  const ids = new Set();
  const dispatched = entry.request_snapshot?.dispatch_correlation_id;
  const callerIds = new Set(Object.values(entry.request_snapshot?.sent_request_ids || {})
    .filter(value => value !== dispatched));
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0 && value.length <= 128 &&
      !callerIds.has(value) && !callerIds.has(value.replace(/^client:/, ''))) ids.add(value);
  };
  add(entry.upstream_request_id);
  for (const value of Object.values(entry.request_snapshot?.sent_request_ids || {})) {
    if (value === dispatched) { add(value); add(`client:${value}`); }
  }
  for (const [header, value] of Object.entries(entry.observed_usage?._recovery?.response_request_ids || {})) {
    add(value);
    if (header === 'x-client-request-id' && typeof value === 'string' && value.length <= 120) add(`client:${value}`);
  }
  return ids;
}

function upstreamTokens(row) {
  return { input_tokens: count(row.input_tokens ?? row.inputTokens),
    output_tokens: count(row.output_tokens ?? row.outputTokens),
    cache_creation_tokens: count(row.cache_creation_tokens ?? row.cacheCreationTokens),
    cache_read_tokens: count(row.cache_read_tokens ?? row.cacheReadTokens) };
}

module.exports = { observedTokens, requestIds, upstreamTokens };
