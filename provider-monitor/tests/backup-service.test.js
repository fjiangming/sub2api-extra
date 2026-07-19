const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { TransferService } = require('../src/services/transfer-service');
const { BackupService, signS3Put } = require('../src/services/backup-service');

function services(context, fetcher) {
  const providers = new ProviderRepository(context.db, context.config);
  const transfers = new TransferService({ db: context.db, config: context.config, providers });
  return new BackupService({ db: context.db, config: context.config, transfers, fetcher });
}

test('local and WebDAV backup targets keep credentials encrypted and record successful uploads', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const calls = [];
  const backups = services(context, async (url, _config, options) => {
    calls.push({ url, options });
    return { ok: true, status: 201, headers: new Headers() };
  });
  const replicaDirectory = path.join(context.directory, 'replica');
  const local = backups.saveTarget({ name: 'Replica', type: 'local', config: { directory: replicaDirectory }, credentials: {} });
  const localRun = await backups.runTarget(local.id, 'local-test');
  assert.equal(fs.existsSync(localRun.location), true);

  const webdav = backups.saveTarget({
    name: 'WebDAV', type: 'webdav', config: { url: 'https://dav.example/backups/' },
    credentials: { username: 'backup-user', password: 'backup-secret' }
  });
  assert.equal(JSON.stringify(backups.listTargets()).includes('backup-secret'), false);
  const webdavRun = await backups.runTarget(webdav.id, 'webdav-test');
  assert.equal(webdavRun.status, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'PUT');
  assert.match(calls[0].options.headers.Authorization, /^Basic /);
  assert.ok(Buffer.isBuffer(calls[0].options.body));
  assert.equal(backups.listRuns().filter((run) => run.status === 'succeeded').length, 2);
  assert.throws(
    () => backups.saveTarget({ name: 'Bad', type: 'webdav', config: { url: 'https://dav.example', password: 'plain' } }),
    (error) => error.code === 'BACKUP_CREDENTIALS_MISPLACED'
  );
});

test('S3 signing is deterministic and signs payload, date, host and optional session token', () => {
  const headers = signS3Put({
    url: 'https://s3.example/bucket/provider-monitor.db',
    body: Buffer.from('backup-data'),
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret-key',
    sessionToken: 'session-token',
    now: new Date('2026-07-17T00:00:00.000Z')
  });
  assert.equal(headers.host, 's3.example');
  assert.equal(headers['x-amz-date'], '20260717T000000Z');
  assert.equal(headers['x-amz-security-token'], 'session-token');
  assert.equal(headers['x-amz-content-sha256'].length, 64);
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260717\/us-east-1\/s3\/aws4_request/);
});
