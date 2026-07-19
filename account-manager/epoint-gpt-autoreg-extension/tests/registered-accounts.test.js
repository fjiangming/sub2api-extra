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
  'const REGISTERED_ACCOUNTS_STORAGE_KEY = "registeredAccounts";',
  'const ACCOUNT_STATUS_REGISTERED = "registered";',
  'const ACCOUNT_STATUS_CALLBACK_SUCCESS = "callback_success";',
  extractFunction('normalizeRegisteredAccountStatus'),
  extractFunction('getRegisteredAccountStatusRank'),
  extractFunction('normalizeAccountDate'),
  extractFunction('normalizeRegisteredAccount'),
  extractFunction('mergeRegisteredAccountRecords'),
  extractFunction('normalizeRegisteredAccounts'),
  extractFunction('setPersistedRegisteredAccounts'),
  extractFunction('syncRegisteredAccounts'),
  extractFunction('upsertRegisteredAccount'),
].join('\n');

const api = new Function(`
let currentState = { accounts: [] };
const broadcasts = [];
const localWrites = [];

const chrome = {
  storage: {
    local: {
      async set(payload) {
        localWrites.push(payload);
      },
    },
  },
};

async function getState() {
  return currentState;
}

async function setState(updates) {
  currentState = { ...currentState, ...updates };
}

function broadcastDataUpdate(payload) {
  broadcasts.push(payload);
}

${bundle}

return {
  normalizeRegisteredAccounts,
  upsertRegisteredAccount,
  reset(accounts = []) {
    currentState = { accounts };
    broadcasts.length = 0;
    localWrites.length = 0;
  },
  snapshot() {
    return { currentState, broadcasts, localWrites };
  },
};
`)();

(async () => {
  const registeredAt = '2026-04-30T01:00:00.000Z';
  const callbackAt = '2026-04-30T01:05:00.000Z';

  const normalized = api.normalizeRegisteredAccounts([
    { email: 'User@example.com', password: 'first', status: 'registered', registeredAt },
    { email: 'user@example.com', password: '', status: 'callback_success', callbackAt },
  ]);
  assert.strictEqual(normalized.length, 1, 'same email should be deduped case-insensitively');
  assert.strictEqual(normalized[0].status, 'callback_success', 'callback status should win over registered status');
  assert.strictEqual(normalized[0].password, 'first', 'empty incoming password should not clear the saved password');

  api.reset();
  await api.upsertRegisteredAccount({
    email: 'fresh@example.com',
    password: 'secret',
    status: 'registered',
    registeredAt,
  });
  let snapshot = api.snapshot();
  assert.strictEqual(snapshot.currentState.accounts[0].status, 'registered', 'step 8 records registered status');
  assert.strictEqual(snapshot.broadcasts.length, 1, 'account insert should be broadcast to the sidepanel');
  assert.strictEqual(snapshot.localWrites.length, 1, 'account insert should persist to local storage');

  await api.upsertRegisteredAccount({
    email: 'fresh@example.com',
    status: 'callback_success',
    callbackAt,
  });
  snapshot = api.snapshot();
  assert.strictEqual(snapshot.currentState.accounts.length, 1, 'callback update should not create a duplicate account');
  assert.strictEqual(snapshot.currentState.accounts[0].status, 'callback_success', 'step 9 upgrades status');
  assert.strictEqual(snapshot.currentState.accounts[0].password, 'secret', 'callback update keeps the password');
  assert.strictEqual(snapshot.currentState.accounts[0].callbackAt, callbackAt, 'callback timestamp should be saved');

  console.log('registered accounts tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
