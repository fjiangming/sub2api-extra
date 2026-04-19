/**
 * 一键构建加密扩展包
 *
 * 用法: node protection/scripts/build-protected.js
 *       或 cd protection && npm run build
 *
 * 流程:
 *   1. 清空 dist/extension-protected/
 *   2. 复制原始扩展 → dist/
 *   3. 深度混淆所有 JS 文件
 *   4. 打包为 ZIP → public/epoint-gpt-autoreg-extension.zip
 */

const fs = require('fs');
const path = require('path');

// ── 路径 ──

const ROOT = path.resolve(__dirname, '../..');
const PROTECTION_DIR = path.resolve(__dirname, '..');
const SRC_EXT = path.join(ROOT, 'epoint-gpt-autoreg-extension');
const DIST_DIR = path.join(PROTECTION_DIR, 'dist', 'extension-protected');
const ZIP_OUTPUT = path.join(ROOT, 'public', 'epoint-gpt-autoreg-extension.zip');

// ── 混淆配置 ──

// 深度混淆（核心业务逻辑）
const PRESET_DEEP = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.6,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  debugProtection: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64', 'rc4'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 1,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

// 轻度混淆（UI 脚本，避免破坏 DOM id 引用）
const PRESET_LIGHT = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.5,
  splitStrings: true,
  splitStringsChunkLength: 12,
};

// 需要深度混淆的文件
const DEEP_FILES = [
  'background.js',
  'hotmail-utils.js',
  'content/signup-page.js',
  'content/sub2api-panel.js',
  'content/utils.js',
  'content/activation-utils.js',
  'shared/oauth-step-helpers.js',
  'shared/step3-flow.js',
  'shared/step9-bypass.js',
  'shared/verification-timing.js',
  'shared/verification-mail-return.js',
];

// 跳过混淆的文件
const SKIP_FILES = [
  'data/names.js',
];

async function main() {
  const startTime = Date.now();
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Sub2API Extra — 一键构建加密扩展包     ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // 1. 清空
  console.log('[1/4] 清空输出目录...');
  if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 2. 复制
  console.log('[2/4] 复制原始扩展...');
  copyDir(SRC_EXT, DIST_DIR, ['.git', 'node_modules', 'tests', 'package.json', '.gitignore', 'LICENSE']);
  console.log(`      ${countFiles(DIST_DIR)} 个文件`);

  // 3. 混淆
  console.log('[3/4] 混淆 JS...');
  await obfuscate();

  // 4. 打包 ZIP
  console.log('[4/4] 打包 ZIP...');
  await createZip();

  const sec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ 完成! ${sec}s`);
  console.log(`   产出: ${ZIP_OUTPUT}\n`);
}

async function obfuscate() {
  let JO;
  try {
    JO = require('javascript-obfuscator');
  } catch {
    try { JO = require(path.join(ROOT, 'node_modules', 'javascript-obfuscator')); } catch {
      console.warn('   ⚠ javascript-obfuscator 未安装，跳过混淆');
      return;
    }
  }

  const files = findJs(DIST_DIR);
  let deep = 0, light = 0, skip = 0;

  for (const abs of files) {
    const rel = path.relative(DIST_DIR, abs).replace(/\\/g, '/');
    if (SKIP_FILES.includes(rel)) { skip++; continue; }

    const code = fs.readFileSync(abs, 'utf8');
    if (code.length < 50) { skip++; continue; }

    const preset = DEEP_FILES.includes(rel) ? PRESET_DEEP : PRESET_LIGHT;
    DEEP_FILES.includes(rel) ? deep++ : light++;

    try {
      const result = JO.obfuscate(code, { ...preset, sourceMap: false, target: 'browser-no-eval' });
      fs.writeFileSync(abs, result.getObfuscatedCode(), 'utf8');
    } catch (e) {
      console.warn(`   ⚠ 失败 ${rel}: ${e.message}`);
    }
  }

  console.log(`      深度: ${deep}, 轻度: ${light}, 跳过: ${skip}`);
}

// ── ZIP 打包 ──

async function createZip() {
  const archiver = require('archiver');
  const outputDir = path.dirname(ZIP_OUTPUT);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(ZIP_OUTPUT);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      const sizeKB = (archive.pointer() / 1024).toFixed(1);
      console.log(`      ${sizeKB} KB → ${ZIP_OUTPUT}`);
      resolve();
    });

    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(DIST_DIR, false);
    archive.finalize();
  });
}

// ── 工具 ──

function copyDir(src, dst, exclude = []) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src)) {
    if (exclude.includes(e)) continue;
    const s = path.join(src, e), d = path.join(dst, e);
    fs.statSync(s).isDirectory() ? copyDir(s, d, exclude) : fs.copyFileSync(s, d);
  }
}

function findJs(dir) {
  const r = [];
  for (const e of fs.readdirSync(dir)) {
    const f = path.join(dir, e);
    fs.statSync(f).isDirectory() ? r.push(...findJs(f)) : e.endsWith('.js') && r.push(f);
  }
  return r;
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir)) {
    const f = path.join(dir, e);
    fs.statSync(f).isDirectory() ? n += countFiles(f) : n++;
  }
  return n;
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
