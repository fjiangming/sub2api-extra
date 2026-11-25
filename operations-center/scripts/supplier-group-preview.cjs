'use strict';
const { DateTime } = require('luxon');
const { supplierGroupFixture } = require('../tests/supplier-group-fixture');
const { startPreview: accountingPreview } = require('./accounting-preview.cjs');

async function startPreview({ port = 0 } = {}) {
  const fixture = await supplierGroupFixture({ date: DateTime.now().setZone('Asia/Shanghai').toISODate(), history: true, timeoutMs: 10000 });
  try {
    const preview = await accountingPreview({ port, supplierGroups: fixture.service });
    return { ...preview, fixture, async close() { await preview.close(); await fixture.close(); } };
  } catch (error) { await fixture.close(); throw error; }
}
if (require.main === module) startPreview({ port: Number(process.env.PORT || 19882) }).then(preview => {
  console.log(`Supplier group example (synthetic data): http://127.0.0.1:${preview.port}/preview`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.close().then(() => process.exit(0)));
}).catch(error => { console.error(error); process.exit(1); });
module.exports = { startPreview };
