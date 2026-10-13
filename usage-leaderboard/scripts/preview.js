'use strict';

// This entry point and its in-memory PostgreSQL dependency are excluded from Docker.
const { loadConfig } = require('../src/config');
const { createRuntime, listen } = require('../src/server');
const { AppError } = require('../src/errors');
const { memoryDatabase, insertUsers, insertLogs } = require('../tests/helpers');

const USERS = [
  ['shanhai@example.com', 128600000, 9], ['pixel@example.net', 96300000, 12], ['night@example.org', 78400000, 7],
  ['yuzu@example.com', 62500000, 6], ['mori@example.net', 51700000, 5], ['weiguang@example.com', 48200000, 4],
  ['planet@example.org', 42600000, 4], ['evan@example.net', 36900000, 5], ['light@example.com', 28500000, 3],
  ['mint@example.org', 24700000, 3], ['spruce@example.net', 16800000, 2], ['sunset@example.com', 14800000, 2]
];

async function main() {
  const scenario = process.argv[2] || 'normal';
  if (!['normal', 'empty', 'outside', 'unavailable', 'signed-out', 'long-names'].includes(scenario)) throw new Error('Unknown preview scenario');
  const config = loadConfig({ NODE_ENV: 'development', USAGE_LEADERBOARD_PORT: process.env.USAGE_LEADERBOARD_PREVIEW_PORT || '9877' });
  config.preview = scenario !== 'signed-out';
  const database = await memoryDatabase();
  const viewer = scenario === 'outside' ? 120 : 6;
  const users = USERS.map(([email], index) => ({ id: index + 1, username: `preview-user-${index + 1}`,
    email: scenario === 'long-names' ? index === 0 ? '<img src=x onerror=alert(1)>'
      : `long-address-${index}@${'long-domain'.repeat(4)}.example.com` : email }));
  users.push(...Array.from({ length: 108 }, (_, index) => ({ id: index + 13, email: `creator${index + 13}@example.com` })));
  await insertUsers(database, users);
  if (scenario !== 'empty') {
    const logs = [];
    const now = Date.now();
    for (let day = 0; day < 75; day++) {
      const created_at = new Date(now - day * 86400000 - 60000).toISOString();
      for (const [index, [, monthlyTokens, calls]] of USERS.entries()) {
        const dailyFactor = 1 + Math.sin(day * 0.7 + index) * 0.22;
        for (let call = 0; call < calls; call++) {
          const tokens = Math.round(monthlyTokens / 30 / calls * dailyFactor);
          logs.push({ user_id: index + 1, created_at, input_tokens: Math.round(tokens * 0.5),
            output_tokens: Math.round(tokens * 0.2), cache_creation_tokens: Math.round(tokens * 0.1),
            cache_read_tokens: Math.round(tokens * 0.2),
            model: call % 4 === 0 ? 'gpt-5' : call % 3 === 0 ? 'gemini-2.5-pro' : 'claude-sonnet-4-5' });
        }
      }
    }
    logs.push(...Array.from({ length: 108 }, (_, index) => ({ user_id: index + 13,
      created_at: new Date(now - 60000).toISOString(), input_tokens: 1000 + index * 100 })));
    await insertLogs(database, logs);
  }
  if (scenario === 'unavailable') database.query = async () => { throw new AppError('DATABASE_UNAVAILABLE', '暂时无法读取用量数据，请稍后重试', 503); };
  const client = { async me(token) {
    if (token !== 'preview' || scenario === 'signed-out') throw new AppError('AUTH_FAILED', '需要登录', 401);
    return { id: String(viewer), email: users.find((user) => user.id === viewer).email };
  } };
  const runtime = createRuntime(config, { database, client });
  listen(runtime, config);
  console.log(`[usage-leaderboard] preview scenario: ${scenario}; memory fixtures only`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
