'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { AppError } = require('./errors');

const METHOD = 'alipay.data.bill.accountlog.query';
const RESPONSE_KEY = 'alipay_data_bill_accountlog_query_response';
const ERROR_RESPONSE_KEY = 'error_response';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function formatShanghaiDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('无效的支付宝查询时间');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function parseShanghaiDateTime(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    throw new AppError('ALIPAY_ACCOUNTLOG_TIME_INVALID', '支付宝账务流水时间格式无效', { status: 502 });
  }
  const parsed = new Date(`${text.replace(' ', 'T')}+08:00`);
  if (!Number.isFinite(parsed.getTime()) || formatShanghaiDateTime(parsed) !== text) {
    throw new AppError('ALIPAY_ACCOUNTLOG_TIME_INVALID', '支付宝账务流水时间无效', { status: 502 });
  }
  return parsed.toISOString();
}

function canonicalizeParameters(parameters) {
  return Object.keys(parameters)
    .filter((key) => key !== 'sign' && parameters[key] != null && String(parameters[key]) !== '')
    .sort()
    .map((key) => `${key}=${parameters[key]}`)
    .join('&');
}

function normalizePem(value, label) {
  const text = String(value || '').trim();
  if (text.includes('-----BEGIN ')) return `${text}\n`;
  const compact = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length < 256) {
    throw new Error(`${label} 不是有效的 PEM 或 Base64 密钥`);
  }
  const type = label.includes('私钥') ? 'PRIVATE KEY' : 'PUBLIC KEY';
  const lines = compact.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`;
}

function readKeyFile(filePath, label, env) {
  const realPath = fs.realpathSync(filePath);
  const stat = fs.statSync(realPath);
  if (!stat.isFile() || stat.size < 256 || stat.size > 64 * 1024) {
    throw new Error(`${label}必须指向 256 字节到 64 KiB 的普通文件`);
  }
  if (env === 'production' && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label}权限过宽；生产环境请设置为 0400 或 0600`);
  }
  return normalizePem(fs.readFileSync(realPath, 'utf8'), label);
}

function assertRsaKey(key, label, requirePrivate) {
  if (key.asymmetricKeyType !== 'rsa' || Number(key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
    throw new Error(`${label}必须是至少 2048 位的 RSA 密钥`);
  }
  if (requirePrivate && key.type !== 'private') throw new Error(`${label}必须是私钥`);
  if (!requirePrivate && key.type !== 'public') throw new Error(`${label}必须是公钥`);
}

function parseJsonStringEnd(source, start) {
  if (source[start] !== '"') throw new Error('JSON 字符串起点无效');
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' && !escaped) return index + 1;
    if (char === '\\') escaped = !escaped;
    else escaped = false;
  }
  throw new Error('JSON 字符串未闭合');
}

function parseJsonValueEnd(source, start) {
  const first = source[start];
  if (first === '"') return parseJsonStringEnd(source, start);
  if (first === '{' || first === '[') {
    const stack = [first === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (char === '"' && !escaped) inString = false;
        if (char === '\\') escaped = !escaped;
        else escaped = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === '}' || char === ']') {
        if (stack.pop() !== char) throw new Error('JSON 括号不匹配');
        if (stack.length === 0) return index + 1;
      }
    }
    throw new Error('JSON 值未闭合');
  }
  let index = start;
  while (index < source.length && source[index] !== ',' && source[index] !== '}') index += 1;
  return index;
}

function extractTopLevelMembers(source) {
  let index = 0;
  const skipSpace = () => { while (/\s/.test(source[index] || '')) index += 1; };
  skipSpace();
  if (source[index] !== '{') throw new Error('支付宝响应不是 JSON 对象');
  index += 1;
  const members = new Map();
  while (index < source.length) {
    skipSpace();
    if (source[index] === '}') return members;
    const keyEnd = parseJsonStringEnd(source, index);
    const key = JSON.parse(source.slice(index, keyEnd));
    if (members.has(key)) throw new Error(`支付宝响应包含重复字段: ${key}`);
    index = keyEnd;
    skipSpace();
    if (source[index] !== ':') throw new Error('支付宝响应 JSON 缺少冒号');
    index += 1;
    skipSpace();
    const valueStart = index;
    const valueEnd = parseJsonValueEnd(source, valueStart);
    members.set(key, source.slice(valueStart, valueEnd));
    index = valueEnd;
    skipSpace();
    if (source[index] === ',') {
      index += 1;
      continue;
    }
    if (source[index] === '}') return members;
    throw new Error('支付宝响应 JSON 分隔符无效');
  }
  throw new Error('支付宝响应 JSON 未闭合');
}

async function readTextLimited(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AppError('ALIPAY_RESPONSE_TOO_LARGE', '支付宝响应超出安全限制', { status: 502 });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AppError('ALIPAY_RESPONSE_TOO_LARGE', '支付宝响应超出安全限制', { status: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function signedMoneyToMinor(value) {
  const match = /^(-?)(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(String(value || '').trim());
  if (!match) throw new AppError('ALIPAY_ACCOUNTLOG_AMOUNT_INVALID', '支付宝账务流水金额无效', { status: 502 });
  const minor = (Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'))) * (match[1] ? -1 : 1);
  if (!Number.isSafeInteger(minor)) {
    throw new AppError('ALIPAY_ACCOUNTLOG_AMOUNT_INVALID', '支付宝账务流水金额超出安全范围', { status: 502 });
  }
  return minor;
}

function boundedString(value, field, required = false, maximum = 4096) {
  const text = value == null ? '' : String(value).trim();
  if ((required && !text) || text.length > maximum || /[\0]/.test(text)) {
    throw new AppError('ALIPAY_ACCOUNTLOG_FIELD_INVALID', `支付宝账务流水字段无效: ${field}`, { status: 502 });
  }
  return text || null;
}

function parseEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new AppError('ALIPAY_ACCOUNTLOG_ENTRY_INVALID', '支付宝返回了无效账务流水', { status: 502 });
  }
  const directionText = boundedString(entry.direction, 'direction', true, 32);
  return {
    accountLogId: boundedString(entry.account_log_id, 'account_log_id', true, 256),
    alipayOrderNo: boundedString(entry.alipay_order_no, 'alipay_order_no', false, 256),
    merchantOrderNo: boundedString(entry.merchant_order_no, 'merchant_order_no', false, 256),
    amount: boundedString(entry.trans_amount, 'trans_amount', true, 64),
    amountMinor: signedMoneyToMinor(entry.trans_amount),
    paidAt: parseShanghaiDateTime(entry.trans_dt),
    direction: directionText === '收入' ? 'income' : directionText === '支出' ? 'expense' : 'unknown',
    memo: boundedString(entry.trans_memo, 'trans_memo'),
    otherAccount: boundedString(entry.other_account, 'other_account', false, 512),
    billSource: boundedString(entry.bill_source, 'bill_source', false, 256),
    type: boundedString(entry.type, 'type', false, 256)
  };
}

class AlipayAccountLogClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
    this.clock = options.clock || (() => new Date());
    const privateKey = options.privateKey || readKeyFile(
      config.alipayAppPrivateKeyPath,
      '支付宝应用私钥',
      config.env
    );
    const publicKey = options.publicKey || readKeyFile(
      config.alipayPublicKeyPath,
      '支付宝公钥',
      config.env
    );
    this.privateKey = privateKey?.type ? privateKey : crypto.createPrivateKey(privateKey);
    this.publicKey = publicKey?.type ? publicKey : crypto.createPublicKey(publicKey);
    assertRsaKey(this.privateKey, '支付宝应用私钥', true);
    assertRsaKey(this.publicKey, '支付宝公钥', false);
  }

  async queryPage({ startTime, endTime, pageNo = 1, pageSize = 1000 }) {
    const start = startTime instanceof Date ? startTime : new Date(startTime);
    const end = endTime instanceof Date ? endTime : new Date(endTime);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end ||
        end.getTime() - start.getTime() > 31 * 86400000) {
      throw new AppError('ALIPAY_QUERY_WINDOW_INVALID', '支付宝账务查询时间范围无效', { status: 500 });
    }
    if (!Number.isInteger(pageNo) || pageNo < 1 || !Number.isInteger(pageSize) || pageSize < 1000 || pageSize > 2000) {
      throw new AppError('ALIPAY_QUERY_PAGE_INVALID', '支付宝账务查询分页参数无效', { status: 500 });
    }
    const bizContent = JSON.stringify({
      start_time: formatShanghaiDateTime(start),
      end_time: formatShanghaiDateTime(end),
      page_no: String(pageNo),
      page_size: String(pageSize)
    });
    const parameters = {
      app_id: this.config.alipayAppId,
      biz_content: bizContent,
      charset: 'utf-8',
      format: 'JSON',
      method: METHOD,
      sign_type: 'RSA2',
      timestamp: formatShanghaiDateTime(this.clock()),
      version: '1.0'
    };
    parameters.sign = crypto.sign(
      'RSA-SHA256',
      Buffer.from(canonicalizeParameters(parameters), 'utf8'),
      this.privateKey
    ).toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.accountLogRequestTimeoutMs);
    let response;
    let body;
    try {
      response = await this.fetch(this.config.alipayGateway, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        },
        body: new URLSearchParams(parameters).toString(),
        redirect: 'error',
        signal: controller.signal
      });
      body = await readTextLimited(response);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AppError('ALIPAY_ACCOUNTLOG_TIMEOUT', '支付宝账务接口请求超时', { status: 504 });
      }
      if (error instanceof AppError) throw error;
      throw new AppError('ALIPAY_ACCOUNTLOG_UNAVAILABLE', '无法连接支付宝账务接口', { status: 503, cause: error });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const error = new AppError('ALIPAY_ACCOUNTLOG_HTTP_ERROR', '支付宝账务接口返回 HTTP 错误', {
        status: 502,
        details: { remoteStatus: response.status }
      });
      if (response.status === 429) error.retryAfterMs = 60000;
      throw error;
    }
    let payload;
    let members;
    try {
      payload = JSON.parse(body);
      members = extractTopLevelMembers(body);
    } catch (error) {
      throw new AppError('ALIPAY_RESPONSE_INVALID', '支付宝账务接口返回了无效 JSON', { status: 502, cause: error });
    }
    const responseKey = members.has(RESPONSE_KEY) ? RESPONSE_KEY : members.has(ERROR_RESPONSE_KEY) ? ERROR_RESPONSE_KEY : null;
    const signature = typeof payload?.sign === 'string' ? payload.sign : '';
    if (!responseKey || !signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
      throw new AppError('ALIPAY_RESPONSE_UNSIGNED', '支付宝账务响应缺少可验证签名', { status: 502 });
    }
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(members.get(responseKey), 'utf8'),
      this.publicKey,
      Buffer.from(signature, 'base64')
    );
    if (!verified) {
      throw new AppError('ALIPAY_RESPONSE_SIGNATURE_INVALID', '支付宝账务响应验签失败', { status: 502 });
    }
    const result = payload[responseKey];
    if (responseKey === ERROR_RESPONSE_KEY || String(result?.code || '') !== '10000') {
      const remoteCode = boundedString(result?.sub_code || result?.code, 'code', false, 128) || 'UNKNOWN';
      const error = new AppError('ALIPAY_ACCOUNTLOG_REJECTED', '支付宝账务接口拒绝了查询', {
        status: 502,
        details: { remoteCode }
      });
      if (/LIMIT|RATE|FLOW/i.test(remoteCode)) error.retryAfterMs = 60000;
      throw error;
    }
    const detailList = result.detail_list == null ? [] : result.detail_list;
    if (!Array.isArray(detailList) || detailList.length > pageSize) {
      throw new AppError('ALIPAY_ACCOUNTLOG_PAGE_INVALID', '支付宝账务接口分页响应无效', { status: 502 });
    }
    const responsePageNo = Number(result.page_no);
    const responsePageSize = Number(result.page_size);
    const totalSize = Number(result.total_size || 0);
    if (!Number.isSafeInteger(responsePageNo) || responsePageNo !== pageNo ||
        !Number.isSafeInteger(responsePageSize) || responsePageSize !== pageSize ||
        !Number.isSafeInteger(totalSize) || totalSize < detailList.length) {
      throw new AppError('ALIPAY_ACCOUNTLOG_PAGE_INVALID', '支付宝账务接口分页元数据无效', { status: 502 });
    }
    return {
      entries: detailList.map(parseEntry),
      pageNo: responsePageNo,
      pageSize: responsePageSize,
      totalSize
    };
  }
}

module.exports = {
  AlipayAccountLogClient,
  METHOD,
  RESPONSE_KEY,
  canonicalizeParameters,
  extractTopLevelMembers,
  formatShanghaiDateTime,
  parseShanghaiDateTime,
  parseEntry
};
