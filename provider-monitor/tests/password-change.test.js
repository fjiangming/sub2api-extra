const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { createDatabase } = require('../src/db');
const { createApplication } = require('../src/server');
const { verifyScryptPassword } = require('../src/security/encryption');

async function startApplication(config, db) {
  const app = createApplication({ config, db, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    app,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  };
}

async function stopApplication(runtime) {
  if (!runtime) return;
  await new Promise((resolve, reject) => runtime.server.close((error) => error ? reject(error) : resolve()));
  await runtime.app.locals.close();
}

async function login(baseUrl, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password })
  });
  const body = await response.json();
  return {
    response,
    body,
    cookie: response.headers.get('set-cookie')?.split(';')[0] || ''
  };
}

function authenticatedHeaders(session) {
  return {
    Cookie: session.cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.body.csrfToken
  };
}

test('a local administrator can change the password securely and persist it across restarts', async () => {
  const context = createTestContext();
  let firstRuntime;
  let secondRuntime;

  try {
    firstRuntime = await startApplication(context.config, context.db);
    const primary = await login(firstRuntime.baseUrl, 'test-password');
    const secondary = await login(firstRuntime.baseUrl, 'test-password');
    assert.equal(primary.response.status, 200);
    assert.equal(secondary.response.status, 200);
    assert.equal(primary.body.authentication.passwordChangeSupported, true);
    assert.equal(primary.body.authentication.passwordChangedAt, null);

    const csrfFailure = await fetch(`${firstRuntime.baseUrl}/api/auth/password`, {
      method: 'POST',
      headers: { Cookie: primary.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'test-password', newPassword: 'new-test-password-123' })
    });
    assert.equal(csrfFailure.status, 403);

    const wrongCurrent = await fetch(`${firstRuntime.baseUrl}/api/auth/password`, {
      method: 'POST',
      headers: authenticatedHeaders(primary),
      body: JSON.stringify({ currentPassword: 'wrong-password', newPassword: 'new-test-password-123' })
    });
    assert.equal(wrongCurrent.status, 401);

    const weakPassword = await fetch(`${firstRuntime.baseUrl}/api/auth/password`, {
      method: 'POST',
      headers: authenticatedHeaders(primary),
      body: JSON.stringify({ currentPassword: 'test-password', newPassword: 'too-short' })
    });
    assert.equal(weakPassword.status, 400);

    const changed = await fetch(`${firstRuntime.baseUrl}/api/auth/password`, {
      method: 'POST',
      headers: authenticatedHeaders(primary),
      body: JSON.stringify({ currentPassword: 'test-password', newPassword: 'new-test-password-123' })
    });
    assert.equal(changed.status, 200);
    const changeResult = await changed.json();
    assert.equal(changeResult.revokedSessions, 1);
    assert.ok(Date.parse(changeResult.changedAt));

    const currentSession = await fetch(`${firstRuntime.baseUrl}/api/summary`, {
      headers: { Cookie: primary.cookie }
    });
    const revokedSession = await fetch(`${firstRuntime.baseUrl}/api/summary`, {
      headers: { Cookie: secondary.cookie }
    });
    assert.equal(currentSession.status, 200);
    assert.equal(revokedSession.status, 401);

    assert.equal((await login(firstRuntime.baseUrl, 'test-password')).response.status, 401);
    const newLogin = await login(firstRuntime.baseUrl, 'new-test-password-123');
    assert.equal(newLogin.response.status, 200);
    assert.equal(newLogin.body.authentication.passwordChangedAt, changeResult.changedAt);

    const stored = context.db.prepare(`
      SELECT password_hash, password_changed_at
      FROM local_admin_credentials
      WHERE id = 1
    `).get();
    assert.notEqual(stored.password_hash, 'new-test-password-123');
    assert.equal(verifyScryptPassword('new-test-password-123', stored.password_hash), true);
    assert.equal(stored.password_changed_at, changeResult.changedAt);
    const audit = context.db.prepare(`
      SELECT details_json
      FROM audit_logs
      WHERE action = 'auth.password_change'
      ORDER BY created_at DESC
      LIMIT 1
    `).get();
    assert.deepEqual(JSON.parse(audit.details_json), { revokedSessions: 1 });

    await stopApplication(firstRuntime);
    firstRuntime = null;

    const reopenedDatabase = createDatabase(context.config.databasePath);
    secondRuntime = await startApplication(context.config, reopenedDatabase);
    assert.equal((await login(secondRuntime.baseUrl, 'test-password')).response.status, 401);
    const persistedLogin = await login(secondRuntime.baseUrl, 'new-test-password-123');
    assert.equal(persistedLogin.response.status, 200);
    assert.equal(persistedLogin.body.authentication.passwordChangedAt, changeResult.changedAt);
  } finally {
    await stopApplication(secondRuntime);
    await stopApplication(firstRuntime);
    context.cleanup();
  }
});
