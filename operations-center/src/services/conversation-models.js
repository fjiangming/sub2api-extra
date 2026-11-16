'use strict';

const recommendedModels = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-sol',
  'claude-fable-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-opus-5-5', 'gemini-carbon'];

function normalizeModel(value) {
  const model = typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '') : '';
  const claude = /^(?:claude-?)?(fable|opus)-?(\d+)(?:[.-](\d+))?$/.exec(model);
  if (claude) return 'claude-' + claude[1] + '-' + claude[2] + (claude[3] ? '-' + claude[3] : '');
  if (model === 'geminicarbon') return 'gemini-carbon';
  return model.replace(/^kimik(?=\d)/, 'kimi-k');
}

function modelAllowed(policy, model) {
  if (!policy.modelFilterEnabled) return true;
  const normalized = normalizeModel(model);
  if (!normalized) return false;
  if (policy.allowedModels.some(value => normalizeModel(value) === normalized)) return true;
  const kimi = /^kimi-?k(\d{1,4})(?:(?:[.-]\d+)*)(?:-[a-z][a-z0-9.-]*)?$/.exec(normalized);
  return Boolean(policy.kimiK3Plus && kimi && Number(kimi[1]) >= 3);
}

module.exports = { recommendedModels, normalizeModel, modelAllowed };
