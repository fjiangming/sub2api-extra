const { AppError } = require('../errors');
const { Sub2ApiAdapter } = require('./sub2api');
const { OneApiFamilyAdapter } = require('./one-api-family');
const { DeepSeekAdapter } = require('./deepseek');
const { OpenRouterAdapter } = require('./openrouter');
const { LiteLlmAdapter } = require('./litellm');
const { VoApiV2Adapter } = require('./voapi-v2');
const { CustomAdapter } = require('./custom');

const ADAPTERS = {
  sub2api: Sub2ApiAdapter,
  'new-api': OneApiFamilyAdapter,
  'one-api': OneApiFamilyAdapter,
  'one-hub': OneApiFamilyAdapter,
  'done-hub': OneApiFamilyAdapter,
  veloera: OneApiFamilyAdapter,
  deepseek: DeepSeekAdapter,
  openrouter: OpenRouterAdapter,
  litellm: LiteLlmAdapter,
  'voapi-v2': VoApiV2Adapter,
  custom: CustomAdapter
};

function createAdapter(type, context) {
  const Adapter = ADAPTERS[type];
  if (!Adapter) {
    throw new AppError('ADAPTER_NOT_FOUND', `Unsupported provider adapter: ${type}`, {
      status: 400
    });
  }
  return new Adapter(context);
}

function listAdapterTypes() {
  return Object.keys(ADAPTERS);
}

module.exports = {
  createAdapter,
  listAdapterTypes
};
