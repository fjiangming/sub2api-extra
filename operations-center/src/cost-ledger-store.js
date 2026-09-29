'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { AppError } = require('./errors');

const VERSION = 2;
const LEGACY_VERSION = 1;
const MAX_ENTRIES = 50000;

function emptyLedger() {
  return {
    version: VERSION,
    entries: [],
    incomes: [],
    providers: [],
    providerSync: {
      status: 'never',
      syncedAt: null,
      attemptedAt: null,
      error: null
    }
  };
}

function validBaseEntry(entry) {
  return entry && typeof entry.id === 'string' && typeof entry.name === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && Number.isSafeInteger(entry.amountMinor) &&
    entry.amountMinor > 0 && typeof entry.currency === 'string' && typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string';
}

function validExpense(entry) {
  return validBaseEntry(entry) && ['provider', 'custom'].includes(entry.kind);
}

function validProvider(provider) {
  return provider && typeof provider.id === 'string' && typeof provider.name === 'string';
}

function validSharedLedger(value) {
  return value && Array.isArray(value.entries) && Array.isArray(value.providers) &&
    value.providerSync && typeof value.providerSync === 'object' &&
    value.entries.every(validExpense) && value.providers.every(validProvider) &&
    typeof value.providerSync.status === 'string';
}

function migrateLedger(value) {
  if (!validSharedLedger(value)) return null;
  if (value.version === LEGACY_VERSION && value.entries.length <= MAX_ENTRIES) {
    return { ...value, version: VERSION, incomes: [] };
  }
  if (value.version !== VERSION || !Array.isArray(value.incomes) ||
      !value.incomes.every(validBaseEntry) || value.entries.length + value.incomes.length > MAX_ENTRIES) {
    return null;
  }
  return value;
}

function assertCapacity(state) {
  if (state.entries.length + state.incomes.length >= MAX_ENTRIES) {
    throw new AppError('COST_LEDGER_LIMIT_REACHED', `收支台账最多保存 ${MAX_ENTRIES} 条记录`, { status: 409 });
  }
}

class CostLedgerStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, 'cost-ledger.json');
    this.state = emptyLedger();
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      const migrated = migrateLedger(stored);
      if (!migrated) throw new Error('unsupported cost ledger format');
      this.state = migrated;
      if (stored.version !== VERSION) await this.#write(this.state);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new AppError('COST_LEDGER_INVALID', '成本台账文件损坏或版本不受支持', { expose: false });
      }
      await this.#write(this.state);
    }
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  entries() {
    return structuredClone(this.state.entries);
  }

  incomeEntries() {
    return structuredClone(this.state.incomes);
  }

  providers() {
    return {
      items: structuredClone(this.state.providers),
      sync: structuredClone(this.state.providerSync)
    };
  }

  async createEntry(input) {
    return this.#update((state) => {
      assertCapacity(state);
      const now = new Date().toISOString();
      const entry = {
        id: crypto.randomUUID(),
        ...input,
        createdAt: now,
        updatedAt: now
      };
      state.entries.push(entry);
      return entry;
    });
  }

  async updateEntry(id, input) {
    return this.#update((state) => {
      const index = state.entries.findIndex((entry) => entry.id === id);
      if (index < 0) {
        throw new AppError('COST_ENTRY_NOT_FOUND', '支出记录不存在', { status: 404 });
      }
      state.entries[index] = {
        ...state.entries[index],
        ...input,
        id,
        updatedAt: new Date().toISOString()
      };
      return state.entries[index];
    });
  }

  async deleteEntry(id) {
    return this.#update((state) => {
      const index = state.entries.findIndex((entry) => entry.id === id);
      if (index < 0) {
        throw new AppError('COST_ENTRY_NOT_FOUND', '支出记录不存在', { status: 404 });
      }
      const [removed] = state.entries.splice(index, 1);
      return removed;
    });
  }

  async createIncomeEntry(input) {
    return this.#update((state) => {
      assertCapacity(state);
      const now = new Date().toISOString();
      const entry = {
        id: crypto.randomUUID(),
        ...input,
        createdAt: now,
        updatedAt: now
      };
      state.incomes.push(entry);
      return entry;
    });
  }

  async updateIncomeEntry(id, input) {
    return this.#update((state) => {
      const index = state.incomes.findIndex((entry) => entry.id === id);
      if (index < 0) {
        throw new AppError('COST_INCOME_NOT_FOUND', '手工收入记录不存在', { status: 404 });
      }
      state.incomes[index] = {
        ...state.incomes[index],
        ...input,
        id,
        updatedAt: new Date().toISOString()
      };
      return state.incomes[index];
    });
  }

  async deleteIncomeEntry(id) {
    return this.#update((state) => {
      const index = state.incomes.findIndex((entry) => entry.id === id);
      if (index < 0) {
        throw new AppError('COST_INCOME_NOT_FOUND', '手工收入记录不存在', { status: 404 });
      }
      const [removed] = state.incomes.splice(index, 1);
      return removed;
    });
  }

  async replaceProviders(items) {
    return this.#update((state) => {
      const now = new Date().toISOString();
      state.providers = items;
      state.providerSync = {
        status: 'ok',
        syncedAt: now,
        attemptedAt: now,
        error: null
      };
      return state.providerSync;
    });
  }

  async recordProviderSyncFailure(message) {
    return this.#update((state) => {
      state.providerSync = {
        ...state.providerSync,
        status: 'error',
        attemptedAt: new Date().toISOString(),
        error: String(message || '供应商同步失败').slice(0, 500)
      };
      return state.providerSync;
    });
  }

  async #update(mutator) {
    let output;
    const operation = async () => {
      const next = this.snapshot();
      output = mutator(next);
      await this.#write(next);
      this.state = next;
      return structuredClone(output);
    };
    this.queue = this.queue.then(operation, operation);
    return this.queue;
  }

  async #write(value) {
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
  }
}

module.exports = { CostLedgerStore, emptyLedger, migrateLedger, MAX_ENTRIES };
