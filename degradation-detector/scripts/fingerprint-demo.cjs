'use strict';

const { createPreview } = require('./model-preview.cjs');

// Preserve the approved preview URL while using the implemented application directly.
const createFingerprintDemo = (port = 19896) => createPreview(port);

if (require.main === module) {
  createFingerprintDemo(Number(process.env.PORT || 19896)).then(preview => {
    console.log(`检测结果：${preview.baseUrl}/results?demo=readonly`);
    console.log(`模型检测：${preview.baseUrl}/model-results?demo=readonly`);
    console.log(`管理员配置：${preview.baseUrl}/admin/config?demo=1`);
    console.log('正式页面的隔离预览；仅模拟检测记录，不调用真实模型或下载参考数据。');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.close().then(() => process.exit(0)));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { createFingerprintDemo };
