'use strict';

// This preview uses an isolated in-memory PostgreSQL database and the production HTTP/UI code.
const http = require('node:http');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');
const { profileFixture } = require('./profile-fixture');
const { addUtcDays } = require('../src/services/metrics-service');

async function startPreview({ port = Number(process.env.PROFILE_PREVIEW_PORT || 9877) } = {}) {
  const fixture = await profileFixture();
  const names = ['陈予安', '周时雨', '许清和', '陆以宁', '沈星澜', '顾南栀', '宋知远', '苏晚晴',
    '叶景行', '温若溪', '季云舟', '夏书遥', '江言川', '程慕白', '唐嘉禾', '秦亦然', '乔初月',
    '何序', '方若宁', '蒋之恒', '罗清晏', '白羽', '徐听澜', '梁嘉木', '林晚', '孟青', '吴昱', '钟悦'];
  await fixture.database.engine.query(`INSERT INTO users (id, username, email, balance)
    SELECT id, username, email, balance FROM jsonb_to_recordset($1::jsonb) u(id bigint, username text, email text, balance numeric)`,
  [JSON.stringify(names.map((username, i) => ({ id: 10 + i, username, email: `user${10 + i}@example.test`, balance: i % 7 === 0 ? 0.1 : 15 + i * 9 })))]);
  const logs = [];
  const models = ['claude-sonnet-4-5', 'gpt-5', 'gemini-2.5-pro', 'claude-opus-4-1', 'gpt-5-mini', 'gemini-2.5-flash'];
  for (let i = 0; i < names.length; i++) {
    for (let day = 0; day < 30; day++) {
      if ((i + day) % 5 === 0) continue;
      const decline = i % 8 === 0;
      const requests = decline && day >= 23 ? 1 : decline && day >= 16 ? 17 : 2 + (i * 11 + day * 7) % 14;
      for (let request = 0; request < requests; request++) {
        const modelIndex = (i + Math.floor(request / 5) + day % 3) % models.length;
        const group = [1, 2, 3, 1, 2, 3][modelIndex];
        logs.push({ user_id: i + 10, group_id: group, account_id: group === 3 ? 3 : group,
          requested_model: models[modelIndex], billing_type: i % 6 === 0 && request % 3 === 0 ? 1 : 0,
          actual_cost: (1 + i % 7) * (0.06 + modelIndex * 0.017), input_tokens: 500 + i * 30,
          output_tokens: 120 + day * 7, cache_read_tokens: 300 + request * 20, cache_creation_tokens: day % 3 === 0 ? 90 : 0,
          created_at: `${addUtcDays('2026-09-14', day)}T04:${String(request % 60).padStart(2, '0')}:00Z` });
      }
    }
  }
  await fixture.insert(logs);
  await fixture.aggregate();
  const config = { ...fixture.config, env: 'test', authMode: 'local', trustProxy: false,
    adminUser: 'admin', adminPassword: 'profiles-local-demo', sessionTtlMinutes: 120, cookieSecure: false };
  const auth = new AuthService(config);
  const app = createApp({ config, auth, database: fixture.database, inspector: fixture.inspector, profiles: fixture.profiles,
    settings: { getStatus: () => ({ setupRequired: false }) } });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch(async (error) => { auth.close(); await fixture.database.close(); throw error; });
  const url = `http://127.0.0.1:${server.address().port}/#profiles`;
  console.info(`Isolated profile verification: ${url}`);
  console.info('Fixture login: admin / profiles-local-demo. No live Sub2API data or credentials are used.');
  const stop = async () => {
    auth.close();
    await new Promise((resolve) => server.close(resolve));
    await fixture.database.close();
  };
  return { url, stop };
}
if (require.main === module) {
  startPreview().then(({ stop }) => {
    process.once('SIGINT', () => stop().then(() => process.exit(0)));
    process.once('SIGTERM', () => stop().then(() => process.exit(0)));
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { startPreview };
