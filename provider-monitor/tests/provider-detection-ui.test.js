const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createElement() {
  return {
    addEventListener() {},
    append() {},
    classList: { add() {}, remove() {}, toggle() {} },
    close() {},
    dataset: {},
    elements: {},
    hidden: false,
    innerHTML: '',
    querySelector() { return this; },
    querySelectorAll() { return []; },
    remove() {},
    showModal() {},
    style: {},
    textContent: ''
  };
}

function createBrowserContext(detectionPayload) {
  const element = createElement();
  const document = {
    addEventListener() {},
    createElement,
    querySelector() { return element; },
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({
    AbortController,
    Blob,
    URL,
    clearTimeout,
    confirm() { return false; },
    console,
    document,
    fetch: async (request) => {
      if (request === '/api/auth/me') throw new Error('No active test session');
      return {
        ok: true,
        status: 200,
        async json() { return detectionPayload; }
      };
    },
    setTimeout,
    window: { addEventListener() {}, lucide: null }
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'public/app.js' });
  return context;
}

function createProviderForm({ adapterType = 'sub2api', adapterTouched = false } = {}) {
  return {
    dataset: {
      adapterTouched: String(adapterTouched),
      credentialsTouched: 'false',
      autoDetectedAdapter: ''
    },
    elements: {
      adapterType: { value: adapterType },
      authMode: { value: 'account' },
      baseUrl: { value: 'api.deepseek.com' },
      id: { value: '' }
    },
    querySelectorAll() { return []; }
  };
}

const deepSeekDetection = {
  baseUrl: 'https://api.deepseek.com',
  recommended: { adapterType: 'deepseek', confidence: 0.99, evidence: 'official_hostname' },
  ambiguous: false,
  suggestions: [{ adapterType: 'deepseek', confidence: 0.99, evidence: 'official_hostname' }],
  probes: []
};

test('provider form normalizes a bare domain and automatically applies a confident detection', async () => {
  const context = createBrowserContext(deepSeekDetection);
  const form = createProviderForm();
  context.testForm = form;

  assert.equal(vm.runInContext("normalizeProviderBaseUrl('api.deepseek.com')", context), 'https://api.deepseek.com');
  const outcome = await vm.runInContext('detectProvider(testForm)', context);

  assert.equal(outcome.applied, true);
  assert.equal(form.elements.baseUrl.value, 'https://api.deepseek.com');
  assert.equal(form.elements.adapterType.value, 'deepseek');
  assert.equal(form.elements.authMode.value, 'api_key');
});

test('automatic detection preserves a manual adapter choice until explicit re-detection', async () => {
  const context = createBrowserContext(deepSeekDetection);
  const form = createProviderForm({ adapterType: 'openrouter', adapterTouched: true });
  context.testForm = form;

  const automatic = await vm.runInContext('detectProvider(testForm)', context);
  assert.equal(automatic.applied, false);
  assert.equal(form.elements.adapterType.value, 'openrouter');

  const manual = await vm.runInContext('detectProvider(testForm, { manual: true })', context);
  assert.equal(manual.applied, true);
  assert.equal(form.elements.adapterType.value, 'deepseek');
  assert.equal(form.dataset.adapterTouched, 'false');
});
