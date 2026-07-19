const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('background.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map(marker => source.indexOf(marker))
    .find(index => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end++) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

const bundle = [
  'const REGISTER_ONLY_LAST_STEP = 5;',
  'const FLOW_LAST_STEP = 9;',
  extractFunction('isStepDoneStatus'),
  extractFunction('isRegisterOnlyMode'),
  extractFunction('isRegisterOnlySkippedStep'),
  extractFunction('markRegisterOnlyRemainingStepsSkipped'),
].join('\n');

const api = new Function(`
let currentState = {
  registerOnlyMode: true,
  stepStatuses: {
    1: 'completed',
    2: 'completed',
    3: 'completed',
    4: 'completed',
    5: 'completed',
    6: 'pending',
    7: 'failed',
    8: 'completed',
    9: 'pending',
  },
};
const statusCalls = [];
const logs = [];

async function getState() {
  return currentState;
}

async function setStepStatus(step, status) {
  statusCalls.push({ step, status });
  currentState.stepStatuses[step] = status;
}

async function addLog(message, level) {
  logs.push({ message, level });
}

${bundle}

return {
  isRegisterOnlyMode,
  isRegisterOnlySkippedStep,
  markRegisterOnlyRemainingStepsSkipped,
  reset(state) {
    currentState = state;
    statusCalls.length = 0;
    logs.length = 0;
  },
  snapshot() {
    return { currentState, statusCalls, logs };
  },
};
`)();

(async () => {
  assert.strictEqual(api.isRegisterOnlyMode({ registerOnlyMode: true }), true);
  assert.strictEqual(api.isRegisterOnlyMode({ registerOnlyMode: false }), false);
  assert.strictEqual(api.isRegisterOnlySkippedStep(5, { registerOnlyMode: true }), false);
  assert.strictEqual(api.isRegisterOnlySkippedStep(6, { registerOnlyMode: true }), true);
  assert.strictEqual(api.isRegisterOnlySkippedStep(9, { registerOnlyMode: true }), true);
  assert.strictEqual(api.isRegisterOnlySkippedStep(10, { registerOnlyMode: true }), false);
  assert.strictEqual(api.isRegisterOnlySkippedStep(6, { registerOnlyMode: false }), false);

  const skipped = await api.markRegisterOnlyRemainingStepsSkipped();
  const snapshot = api.snapshot();
  assert.deepStrictEqual(skipped, [6, 7, 9], 'only unfinished steps after step 5 should be skipped');
  assert.deepStrictEqual(snapshot.statusCalls, [
    { step: 6, status: 'skipped' },
    { step: 7, status: 'skipped' },
    { step: 9, status: 'skipped' },
  ]);
  assert.strictEqual(snapshot.currentState.stepStatuses[8], 'completed', 'already completed steps should not be overwritten');
  assert.strictEqual(snapshot.logs.length, 1, 'skipping remaining steps should be logged once');

  api.reset({
    registerOnlyMode: true,
    stepStatuses: {
      5: 'completed',
      6: 'running',
      7: 'skipped',
      8: 'completed',
      9: 'manual_completed',
    },
  });
  assert.deepStrictEqual(
    await api.markRegisterOnlyRemainingStepsSkipped(),
    [],
    'running or already-done steps should not be changed'
  );

  console.log('register only mode tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
