const assert = require('node:assert');
const { test } = require('node:test');
const { extractVerificationCode } = require('../shared/mail-2925.js');

// 模拟 2925 邮件详情页中 innerHTML 被提取为纯文本后的内容
// 对应 "您的临时ChatGPT验证码" 格式的邮件

const emailBody1 = `OpenAI 输入此临时验证码以继续： 819008 如果并非你本人尝试创建 ChatGPT 帐户，请忽略此电子邮件。 谨致问候 ChatGPT 团队 ChatGPT 帮助中心`;

const emailBody2 = `OpenAI 输入此临时验证码以继续： 718542 如果并非你本人尝试创建 ChatGPT 帐户，请忽略此电子邮件。 谨致问候 ChatGPT 团队 ChatGPT 帮助中心`;

// 对应 "你的 ChatGPT 代码为 XXXXXX" 格式的邮件（旧格式，标题就有验证码）
const subjectOld = '你的 ChatGPT 代码为 182912';

// 对应 "您的临时ChatGPT验证码" 格式的标题（新格式，标题没有验证码）
const subjectNew = '您的临时ChatGPT验证码';

test('extractVerificationCode handles new email format body (819008)', () => {
  const code = extractVerificationCode(emailBody1);
  assert.strictEqual(code, '819008');
});

test('extractVerificationCode handles new email format body (718542)', () => {
  const code = extractVerificationCode(emailBody2);
  assert.strictEqual(code, '718542');
});

test('extractVerificationCode handles old subject format with code in subject', () => {
  const code = extractVerificationCode(subjectOld);
  assert.strictEqual(code, '182912');
});

test('extractVerificationCode returns null for new subject without code', () => {
  const code = extractVerificationCode(subjectNew);
  assert.strictEqual(code, null);
});

test('extractVerificationCode works with combined subject + body text', () => {
  const combined = `${subjectNew} ${emailBody1}`;
  const code = extractVerificationCode(combined);
  assert.strictEqual(code, '819008');
});

test('extractVerificationCode works with combined subject + body for second email', () => {
  const combined = `${subjectNew} ${emailBody2}`;
  const code = extractVerificationCode(combined);
  assert.strictEqual(code, '718542');
});

// 模拟更接近 innerText 的原始提取（带换行和多余空白）
const rawInnerText = `OpenAI


输入此临时验证码以继续：

718542

如果并非你本人尝试创建 ChatGPT 帐户，请忽略此电子邮件。


谨致问候
ChatGPT 团队
ChatGPT
帮助中心`;

test('extractVerificationCode works with raw innerText containing newlines (718542)', () => {
  const code = extractVerificationCode(rawInnerText);
  assert.strictEqual(code, '718542');
});

// 验证 normalizeWhitespace + extractVerificationCode 的组合
function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

test('extractVerificationCode works with normalized raw innerText (718542)', () => {
  const normalized = normalizeWhitespace(rawInnerText);
  const code = extractVerificationCode(normalized);
  assert.strictEqual(code, '718542');
});
