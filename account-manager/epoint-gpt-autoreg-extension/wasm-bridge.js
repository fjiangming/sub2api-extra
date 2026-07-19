// wasm-bridge.js — WASM 模块加载与调用桥接层（Service Worker 环境）
// 优先调用 WASM 实现，失败时返回 null 由调用方降级到 JS 实现

const WasmBridge = (() => {
  let _exports = null;
  let _ready = false;

  /**
   * 异步加载并初始化 WASM 模块。
   * 在 Service Worker 启动时调用（fire-and-forget），
   * 加载完成前的调用会自动使用 JS 回退。
   */
  async function init() {
    try {
      const url = chrome.runtime.getURL('core.wasm');
      const response = await fetch(url);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const bytes = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes);
      _exports = instance.exports;
      _reseed();
      _ready = true;
      console.log('[WasmBridge] WASM module loaded');
    } catch (err) {
      console.warn('[WasmBridge] WASM load failed, JS fallback:', err.message || err);
      _ready = false;
    }
  }

  /** 用 crypto.getRandomValues 重新设置 WASM 内部 PRNG 种子 */
  function _reseed() {
    if (!_exports) return;
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    _exports.setSeed(arr[0]);
  }

  /**
   * 生成 14 位随机密码。
   * @returns {string|null} 密码字符串，或 null 表示 WASM 不可用
   */
  function generatePassword() {
    if (!_ready) return null;
    try {
      _reseed();
      _exports.generatePasswordFill();
      let pw = '';
      for (let i = 0; i < 14; i++) {
        pw += String.fromCharCode(_exports.getPasswordCharCode(i));
      }
      return pw;
    } catch { return null; }
  }

  /**
   * 生成 Cloudflare 邮箱别名（10 位，6 字母 + 4 数字 shuffle）。
   * @returns {string|null} 别名字符串，或 null 表示 WASM 不可用
   */
  function generateCloudflareAlias() {
    if (!_ready) return null;
    try {
      _reseed();
      _exports.generateCloudflareAliasFill();
      let alias = '';
      for (let i = 0; i < 10; i++) {
        alias += String.fromCharCode(_exports.getAliasCharCode(i));
      }
      return alias;
    } catch { return null; }
  }

  /**
   * 校验运行次数，确保 >= 1。
   * @returns {number|null} 校验后的整数，或 null 表示 WASM 不可用
   */
  function normalizeRunCount(value) {
    if (!_ready) return null;
    try { return _exports.normalizeRunCount(value); } catch { return null; }
  }

  /**
   * 校验自动运行倒计时分钟数，clamp 到 [1, 1440]。
   * @returns {number|null} 校验后的整数，或 null 表示 WASM 不可用
   */
  function normalizeAutoRunDelayMinutes(value, defaultVal) {
    if (!_ready) return null;
    try { return _exports.normalizeAutoRunDelayMinutes(value, defaultVal); } catch { return null; }
  }

  /**
   * 计算步骤间随机延迟毫秒数。
   * @returns {number|null} 延迟毫秒数，或 null 表示 WASM 不可用
   */
  function getAutoStepRandomDelayMs(minMs, maxMs) {
    if (!_ready) return null;
    try {
      _reseed();
      return _exports.getAutoStepRandomDelayMs(minMs, maxMs);
    } catch { return null; }
  }

  return {
    init,
    get ready() { return _ready; },
    generatePassword,
    generateCloudflareAlias,
    normalizeRunCount,
    normalizeAutoRunDelayMinutes,
    getAutoStepRandomDelayMs,
  };
})();
