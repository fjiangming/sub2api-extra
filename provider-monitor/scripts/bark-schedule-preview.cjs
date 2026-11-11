const http = require('node:http');
const { createApplication } = require('../src/server');
const { createTestContext } = require('../tests/helpers');

async function startPreview({ port = 0 } = {}) {
  const context = createTestContext({ PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD: 'preview-password' });
  const requests = [];
  let now = new Date('2026-11-11T04:00:00Z');
  const receiver = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 200, message: 'Mock push accepted' }));
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const app = createApplication({ ...context, startBackground: false });
  const notifications = app.locals.services.notifications;
  notifications.now = () => now;
  notifications.save({ name: '示例 iPhone', type: 'bark', config: {
    endpoint: `http://127.0.0.1:${receiver.address().port}/push`,
    level: 'timeSensitive', sound: 'alarm'
  }, credentials: { deviceKey: 'preview-only-device-key' } });
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { app, port: server.address().port, requests,
    setNow(value) { now = new Date(value); },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => receiver.close(resolve));
      await app.locals.close();
      context.cleanup();
    }
  };
}

if (require.main === module) {
  startPreview({ port: Number(process.env.BARK_SCHEDULE_PREVIEW_PORT || 0) }).then((preview) => {
    console.log(`Bark schedule preview: http://127.0.0.1:${preview.port} (admin / preview-password)`);
    const close = async () => { await preview.close(); process.exit(0); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { startPreview };
