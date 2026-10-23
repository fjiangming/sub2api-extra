'use strict';

const crypto = require('node:crypto');
const { parse } = require('csv-parse/sync');
const { DateTime } = require('luxon');
const { AppError } = require('../errors');

const aliases = {
  time: ['time', 'createdat', '时间', '请求时间', '创建时间'],
  key: ['apikeyname', 'keyname', '令牌名称', '密钥名称', '密钥', 'apikey'],
  model: ['model', '模型'], requestId: ['requestid', 'upstreamrequestid', '请求id', '请求编号'],
  input: ['inputtokens', 'prompttokens', '输入token', '输入tokens', '输入令牌'],
  output: ['outputtokens', 'completiontokens', '输出token', '输出tokens', '输出令牌'],
  cacheRead: ['cachereadtokens', 'cachereadinputtokens', '缓存读取token', '缓存读取tokens'],
  cacheCreation: ['cachecreationtokens', 'cachecreationinputtokens', '缓存创建token', '缓存创建tokens'],
  cache5m: ['cachecreation5mtokens', '缓存创建5mtoken'], cache1h: ['cachecreation1htokens', '缓存创建1htoken'],
  duration: ['durationms', '耗时ms', '总耗时ms'], cost: ['billedcost', 'actualcost', '费用', '实际费用'],
  type: ['type', '请求类型'], endpoint: ['inboundendpoint', 'endpoint', '入站接口'],
  billingMode: ['billingmode', '计费模式']
};
const headerKey = value => String(value).replace(/[\s_()\-]/g, '').toLowerCase();
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = message => new AppError('INVALID_CSV', message, { status: 400 });

function describeBillingCSV(csv, options = {}) {
  if (typeof csv !== 'string' || !csv.trim() || Buffer.byteLength(csv) > 8 * 1024 * 1024) throw fail('CSV 不能为空，且不能超过 8 MiB');
  let matrix;
  try { matrix = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: 65536, relax_column_count: false }); }
  catch (error) { throw fail(`CSV 格式无效：${error.code || '无法解析'}`); }
  if (matrix.length < 2 || matrix.length > 20001) throw fail('每次导入需要 1 至 20000 条记录');
  const headers = matrix.shift().map(value => value.trim());
  if (headers.length > 100 || headers.some(value => value.length > 200) || new Set(headers.map(headerKey)).size !== headers.length) throw fail('CSV 列名重复、过长或列数超过 100');
  const columns = {};
  for (const [field, names] of Object.entries(aliases)) {
    const selected = options.columns?.[field];
    const index = selected === '' ? -1 : selected ? headers.indexOf(selected) : headers.findIndex(value => names.includes(headerKey(value)));
    if (index >= 0) columns[field] = headers[index];
  }
  return { matrix, headers, columns };
}

function parseBillingCSV(csv, options = {}) {
  const { matrix, headers, columns } = describeBillingCSV(csv, options);
  for (const field of ['time', 'model', 'input', 'output']) if (!columns[field]) throw fail(`缺少 ${field} 列，请设置字段映射`);
  if (!DateTime.now().setZone(options.timezone || 'Asia/Shanghai').isValid) throw fail('时区无效');
  const positions = Object.fromEntries(Object.entries(columns).map(([key, value]) => [key, headers.indexOf(value)]));
  const seen = new Map();
  const rows = matrix.map((cells, index) => {
    const get = field => positions[field] == null ? '' : cells[positions[field]].trim();
    const row = { number: index + 2, key: get('key'), model: get('model'), requestId: get('requestId'), rawTime: get('time'),
      endpoint: get('endpoint'), billingMode: get('billingMode'), cost: get('cost'), durationMs: null,
      stream: /^(stream|streaming|流式)$/i.test(get('type')), tokens: {}, error: null };
    try {
      if (!row.model || row.model.length > 128 || row.requestId.length > 128) throw fail('模型或请求 ID 无效');
      if (row.key.length > 200 || row.rawTime.length > 100 || row.endpoint.length > 300 || row.cost.length > 100 || row.billingMode.length > 50) throw fail('账单字段过长');
      let at = DateTime.fromISO(row.rawTime, { zone: options.timezone || 'Asia/Shanghai', setZone: true });
      if (!at.isValid) {
        for (const format of ['yyyy-MM-dd HH:mm:ss.SSS', 'yyyy-MM-dd HH:mm:ss', 'yyyy/M/d H:mm:ss']) {
          at = DateTime.fromFormat(row.rawTime, format, { zone: options.timezone || 'Asia/Shanghai' });
          if (at.isValid) break;
        }
      }
      if (!at.isValid || at.year < 2000) throw fail('时间格式无效');
      const integer = (field, optional = false) => {
        const value = get(field);
        if (optional && value === '') return null;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw fail(`${field} 必须为有效非负整数`);
        return Number(value);
      };
      row.tokens = { InputTokens: integer('input'), OutputTokens: integer('output'),
        CacheReadTokens: integer('cacheRead', true), CacheCreationTokens: integer('cacheCreation', true),
        CacheCreation5mTokens: integer('cache5m', true), CacheCreation1hTokens: integer('cache1h', true) };
      if (get('duration')) row.durationMs = integer('duration');
      // The supplier identity cannot change when an operator corrects our
      // timezone, clock or inclusive-input interpretation later.
      const fraction = row.rawTime.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/i)?.[1].replace(/0+$/, '') || '';
      const identityTime = /(?:Z|[+-]\d\d:\d\d)$/i.test(row.rawTime)
        ? `${at.toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss")}${fraction ? `.${fraction}` : ''}Z` : row.rawTime;
      row.identity = hash(row.requestId ? ['request', row.requestId] : ['fingerprint', identityTime, row.key, row.model,
        row.tokens, row.durationMs, row.stream, row.endpoint]);
      row.time = at.toUTC().toISO();
      const adjusted = at.toMillis() + Number(options.clockOffsetSeconds || 0) * 1000;
      if (options.timeKind === 'end' && row.durationMs == null) throw fail('结束时间模式需要总耗时列');
      row.startedAt = new Date(adjusted - (options.timeKind === 'end' ? row.durationMs : 0)).toISOString();
      if (options.inputIncludesCache) {
        if (row.tokens.CacheReadTokens == null || row.tokens.CacheCreationTokens == null) throw fail('含缓存的输入 Token 需要缓存明细');
        row.tokens.InputTokens -= row.tokens.CacheReadTokens + row.tokens.CacheCreationTokens;
        if (row.tokens.InputTokens < 0) throw fail('缓存 Token 超出输入 Token');
      }
      // Keep unknown cache dimensions unknown. A later pricing rule must
      // explicitly confirm zero or TTL; missing CSV cells never imply zero.
      const seenKey = `${row.key}:${row.identity}`;
      if (seen.has(seenKey)) row.duplicateOf = seen.get(seenKey);
      else seen.set(seenKey, row.number);
    } catch (error) { row.error = error.message; }
    return row;
  });
  return { headers, columns, rows, keys: [...new Set(rows.map(row => row.key))], models: [...new Set(rows.map(row => row.model))] };
}

module.exports = { parseBillingCSV, describeBillingCSV, hash };
