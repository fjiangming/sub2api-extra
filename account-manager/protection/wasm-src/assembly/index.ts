// ═══════════════════════════════════════════════════════════════
// core WASM module — 纯计算函数，由 JS 侧通过 wasm-bridge 调用
// ═══════════════════════════════════════════════════════════════

// ── PRNG (xorshift32) ──
// JS 侧每次调用前用 crypto.getRandomValues() 提供高质量种子

let seed: u32 = 1;

export function setSeed(s: u32): void {
  seed = s == 0 ? 1 : s;
}

function nextRand(): u32 {
  seed ^= seed << 13;
  seed ^= seed >> 17;
  seed ^= seed << 5;
  return seed;
}

function randInt(upperBound: i32): i32 {
  return <i32>(nextRand() % <u32>upperBound);
}

// ── 密码生成 ──
// 等价于 background.js 的 generatePassword()
// 14 字符，含大写、小写、数字、符号各至少一个

const UPPER: string = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER: string = "abcdefghjkmnpqrstuvwxyz";
const DIGITS: string = "23456789";
const SYMBOLS: string = "!@#$%&*?";
const ALL: string = UPPER + LOWER + DIGITS + SYMBOLS;

const PW_LEN: i32 = 14;
const pwCodes = new StaticArray<i32>(PW_LEN);

export function generatePasswordFill(): void {
  unchecked(pwCodes[0] = UPPER.charCodeAt(randInt(UPPER.length)));
  unchecked(pwCodes[1] = LOWER.charCodeAt(randInt(LOWER.length)));
  unchecked(pwCodes[2] = DIGITS.charCodeAt(randInt(DIGITS.length)));
  unchecked(pwCodes[3] = SYMBOLS.charCodeAt(randInt(SYMBOLS.length)));

  for (let i: i32 = 4; i < PW_LEN; i++) {
    unchecked(pwCodes[i] = ALL.charCodeAt(randInt(ALL.length)));
  }

  // Fisher-Yates shuffle
  for (let i: i32 = PW_LEN - 1; i > 0; i--) {
    const j: i32 = randInt(i + 1);
    const tmp: i32 = unchecked(pwCodes[i]);
    unchecked(pwCodes[i] = pwCodes[j]);
    unchecked(pwCodes[j] = tmp);
  }
}

export function getPasswordCharCode(index: i32): i32 {
  if (<u32>index >= <u32>PW_LEN) return 0;
  return unchecked(pwCodes[index]);
}

// ── Cloudflare 邮箱别名 ──
// 等价于 background.js 的 generateCloudflareAliasLocalPart()
// 6 个字母 + 4 个数字，shuffle 后拼接

const CF_LETTERS: string = "abcdefghijklmnopqrstuvwxyz";
const CF_DIGITS: string = "0123456789";

const ALIAS_LEN: i32 = 10;
const aliasCodes = new StaticArray<i32>(ALIAS_LEN);

export function generateCloudflareAliasFill(): void {
  for (let i: i32 = 0; i < 6; i++) {
    unchecked(aliasCodes[i] = CF_LETTERS.charCodeAt(randInt(CF_LETTERS.length)));
  }
  for (let i: i32 = 6; i < ALIAS_LEN; i++) {
    unchecked(aliasCodes[i] = CF_DIGITS.charCodeAt(randInt(CF_DIGITS.length)));
  }

  // Fisher-Yates shuffle
  for (let i: i32 = ALIAS_LEN - 1; i > 0; i--) {
    const j: i32 = randInt(i + 1);
    const tmp: i32 = unchecked(aliasCodes[i]);
    unchecked(aliasCodes[i] = aliasCodes[j]);
    unchecked(aliasCodes[j] = tmp);
  }
}

export function getAliasCharCode(index: i32): i32 {
  if (<u32>index >= <u32>ALIAS_LEN) return 0;
  return unchecked(aliasCodes[index]);
}

// ── 数值校验函数 ──

export function normalizeRunCount(value: f64): i32 {
  if (isNaN(value) || !isFinite(value)) return 1;
  return max(1, <i32>Math.floor(value));
}

export function normalizeAutoRunDelayMinutes(value: f64, defaultVal: f64): i32 {
  if (isNaN(value) || !isFinite(value)) {
    return <i32>Math.floor(defaultVal);
  }
  const floored: i32 = <i32>Math.floor(value);
  return min(1440, max(1, floored));
}

export function getAutoStepRandomDelayMs(minVal: f64, maxVal: f64): i32 {
  const nMin: i32 = max(0, <i32>Math.floor(isNaN(minVal) ? 0.0 : minVal));
  const nMax: i32 = max(nMin, <i32>Math.floor(isNaN(maxVal) ? <f64>nMin : maxVal));
  if (nMax == nMin) return nMin;
  return <i32>(nextRand() % <u32>(nMax - nMin + 1)) + nMin;
}
