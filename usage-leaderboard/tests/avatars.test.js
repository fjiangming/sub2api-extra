'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { publicIdentity, avatarUrl } = require('../src/identity');
const { AuthService } = require('../src/auth');
const { Sub2ApiClient } = require('../src/sub2api-client');
const { loadConfig } = require('../src/config');
const { generateSimulation, validateCandidate, projectSimulation, DEFAULT_RULES } = require('../src/simulation');
const { memoryDatabase, insertUsers, insertLogs, service } = require('./helpers');

const inlineAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const remoteAvatar = 'https://avatars.example.com/profile.png';

test('public identities use saved image URLs and reject generated names and unsafe sources', () => {
  for (const url of [inlineAvatar, remoteAvatar]) assert.equal(publicIdentity(7, 'reader@example.com', url).avatar, url);
  assert.equal(avatarUrl('/uploads/user.png', 'https://main.example.com'), 'https://main.example.com/uploads/user.png');
  for (const invalid of [undefined, null, '', 'mountain', './assets/sea.jpg', '//untrusted.example/user.png',
    'javascript:alert(1)', 'data:text/html;base64,PGgxPg==', 'data:image/svg+xml;base64,PHN2Zz4=',
    'https://user:password@example.com/user.png', 'data:image/png;base64,' + 'a'.repeat(30000)]) {
    assert.equal(publicIdentity(7, 'reader@example.com', invalid).avatar, null);
  }
});

test('SSO and session revalidation preserve the actual upstream avatar', async (t) => {
  const config = loadConfig({ NODE_ENV: 'test', SUB2API_PUBLIC_URL: 'https://main.example.com' });
  let savedAvatar = '/uploads/user.png';
  let clock = Date.now();
  const client = new Sub2ApiClient(config, { fetchImpl: async () => Response.json({ code: 0,
    data: { id: 7, email: 'reader@example.com', avatar_url: savedAvatar, role: 'user', status: 'active' } }) });
  const auth = new AuthService(config, client, { now: () => clock });
  t.after(() => auth.close());
  const req = { ip: '127.0.0.1', headers: {}, get: () => '' };
  const signedIn = await auth.sso(req, { setHeader() {} }, 'test-token');
  assert.equal(signedIn.user.avatar, 'https://main.example.com/uploads/user.png');
  savedAvatar = inlineAvatar;
  clock += 61000;
  const session = auth.sessions.get(signedIn.sessionToken);
  await auth.refresh(session, {});
  assert.equal(auth.publicSession(session).user.avatar, inlineAvatar);
});

test('ranking, personal usage and qualified previews read only saved avatars, with legacy schema support', async (t) => {
  const db = await memoryDatabase();
  t.after(() => db.close());
  await insertUsers(db, [1, 2, 3, 4].map((id) => ({ id })));
  await insertLogs(db, [1, 2, 3].map((id) => ({ user_id: id, created_at: '2026-10-13T02:00:00Z', input_tokens: 2000000 * id })));
  const legacy = service(db);
  assert.equal((await legacy.inspector.inspect()).userAvatars, false);
  const oldBoard = await legacy.leaderboard.get('month', 'tokens', '1');
  assert.ok(oldBoard.entries.every((entry) => entry.avatar === null));
  assert.equal(oldBoard.me.avatar, null);

  await db.engine.exec('CREATE TABLE public.user_avatars (user_id bigint PRIMARY KEY, url text NOT NULL)');
  await db.engine.query('INSERT INTO public.user_avatars (user_id, url) VALUES (1, $1), (2, $2), (3, $3), (4, $4)',
    [inlineAvatar, remoteAvatar, 'javascript:alert(1)', remoteAvatar]);
  const current = service(db);
  assert.equal((await current.inspector.inspect()).userAvatars, true);
  for (const metric of ['tokens', 'requests']) {
    const board = await current.leaderboard.get('month', metric, '1');
    assert.equal(board.me.avatar, inlineAvatar);
    assert.equal(board.entries.find((entry) => entry.key === board.me.key).avatar, inlineAvatar);
    assert.equal(board.entries.find((entry) => entry.tokens === 4000000).avatar, remoteAvatar);
    assert.equal(board.entries.find((entry) => entry.tokens === 6000000).avatar, null);
    const inactive = await current.leaderboard.get('month', metric, '4');
    assert.equal(inactive.me.avatar, remoteAvatar);
    assert.equal(inactive.me.rank, null);
    const candidate = generateSimulation(DEFAULT_RULES, { now: new Date('2026-10-13T03:30:00Z') });
    const preview = await current.leaderboard.preview(candidate, 'month', metric);
    assert.equal(preview.entries.find((entry) => entry.key === board.me.key).avatar, inlineAvatar);
    assert.ok(preview.entries.filter((entry) => entry.source === 'simulation').every((entry) => entry.avatar === null));
  }
});

test('persisted simulation rosters remain readable while decorative avatars are never published', () => {
  const now = new Date('2026-10-13T03:30:00Z');
  const candidate = generateSimulation(DEFAULT_RULES, { now });
  assert.ok(candidate.rows.every((row) => row.avatar === null));
  const roster = candidate.rows.map(({ key, name }) => ({ key, name, avatar: 'mountain' }));
  const legacy = generateSimulation(DEFAULT_RULES, { now, seed: candidate.seed, roster });
  assert.deepEqual(validateCandidate(legacy, 'Asia/Shanghai'), legacy);
  const board = projectSimulation({ period: 'month', metric: 'tokens', entries: [], qualifiedEntries: [] }, legacy, 'test');
  assert.ok(board.entries.every((entry) => entry.avatar === null));
});
