'use strict';

const isIdentityCard = require('validator/lib/isIdentityCard');
const isCreditCard = require('validator/lib/isCreditCard');
const { default: isIBAN } = require('validator/lib/isIBAN');
const isIP = require('validator/lib/isIP');
const crypto = require('node:crypto');

const REDACTION_VERSION = 3;
function redactionPolicyHash(policy) {
  return crypto.createHash('sha256').update(JSON.stringify([REDACTION_VERSION,
    ...['email','phone','secret','ip','identity','financial','personal','device'].map(key => Boolean(policy[key])), policy.custom])).digest('hex');
}
const normalize = field => String(field).toLowerCase().replace(/[\s_.-]/g, '');
const fields = {
  secret: /^(?:authorization|proxyauthorization|apikey|accesskey(?:id|secret)?|secretaccesskey|awsaccesskeyid|awssecretaccesskey|accesskeysecret|clientsecret|accesstoken|refreshtoken|idtoken|sessiontoken|sessionid|sessionkey|token|password|passwd|pwd|secret|privatekey|signingkey|encryptionkey|connectionstring|cookie|setcookie|credential(?:s)?|otp|pin|cvv|cvc|verificationcode|smscode|recoverycode|验证码|密码|口令|密钥)$/,
  identity: /^(?:id|identity(?:card|number)?|idcard(?:no|number)?|idnumber|citizenid|nationalid|passport(?:no|number)?|ssn|socialsecurity(?:number)?|taxid|taxpayerid|tin|driverlicen[cs]e(?:number)?|licen[cs]enumber|residencepermit|medicalrecordnumber|patientid|studentid|身份证(?:号|号码)?|证件(?:号|号码)?|护照(?:号|号码)?|社保(?:号|号码)?|税号|驾驶证(?:号|号码)?|学号|病历号)$/,
  financial: /^(?:bankaccount(?:number)?|accountnumber|bankcard(?:number)?|cardnumber|creditcard(?:number)?|debitcard(?:number)?|iban|bic|swift|routingnumber|paymentaccount|alipay|wechatpay|wallet(?:address)?|银行卡(?:号)?|银行账号|收款账号|支付宝(?:账号)?|金融账户)$/,
  email: /^(?:email|emailaddress|mail|邮箱|电子邮箱|电子邮件)$/,
  phone: /^(?:phone(?:number)?|mobile(?:number)?|telephone|tel|fax|手机号(?:码)?|手机|电话(?:号码)?|传真)$/,
  ip: /^(?:ip(?:address)?|ipv[46]|clientip|remoteaddr|sourceip|targetip|ip地址)$/,
  device: /^(?:mac(?:address)?|imei|imsi|iccid|meid|androidid|idfa|gaid|advertisingid|device(?:id|serial|fingerprint)|serialnumber|车牌(?:号)?|licenseplate|vin|设备(?:号|编号|指纹)|微信(?:号)?|wechat(?:id)?|qq|qq号|telegram(?:id)?|socialhandle)$/,
  personal: /^(?:name|fullname|firstname|lastname|middlename|realname|username|displayname|nickname|contactname|address|street(?:address)?|postal(?:code|address)?|zipcode|dateofbirth|birthdate|birthday|dob|latitude|longitude|gps|coordinates|location|geolocation|diagnosis|medicalhistory|healthrecord|biometric|fingerprint|姓名|名字|真实姓名|昵称|用户名|住址|地址|详细地址|邮编|出生日期|生日|经度|纬度|定位|坐标|诊断|病史|指纹)$/
};
function fieldKind(field, policy) {
  const key = normalize(field);
  for (const [kind, pattern] of Object.entries(fields)) if (policy[kind] && pattern.test(key)) return kind;
  return '';
}

function geminiPartPath(path) {
  const p = path[0] === 'response' ? path.slice(1) : path;
  return p.length === 4 && p[0] === 'contents' && Number.isInteger(p[1]) && p[2] === 'parts' && Number.isInteger(p[3]) ||
    p.length === 5 && p[0] === 'candidates' && Number.isInteger(p[1]) && p[2] === 'content' && p[3] === 'parts' && Number.isInteger(p[4]);
}

// Keep actual protocol identities; data objects inside tools are handled at a separate depth.
function protocolField(token, parsed, depth) {
  if (depth) return false;
  const p = token.path, field = token.field;
  const parent = p.slice(0, -1).reduce((obj, key) => obj?.[key], parsed);
  const root = p.length === 1 || (p.length === 2 && ['response', 'message', 'item'].includes(p[0]));
  const protocolParent = parent && typeof parent === 'object' && (/^(?:response\.|message\.|function|function_call|function_call_output|custom_tool_call|tool_use|tool_result|text|input_text|output_text|thinking|content_block|image|image_url|document|audio)/.test(parent.type || '') ||
    ['user','assistant','system','developer','tool','model'].includes(parent.role));
  if (['id','name'].includes(field) && ['functionCall','functionResponse','function_call','function_response'].includes(p.at(-2)) && geminiPartPath(p.slice(0,-2))) return true;
  if (field === 'name' && p.length === 5 && p[0] === 'tools' && Number.isInteger(p[1]) && ['functionDeclarations','function_declarations'].includes(p[2]) && Number.isInteger(p[3])) return true;
  if (['call_id','tool_call_id','tool_use_id','previous_response_id','item_id','response_id'].includes(field)) {
    return root || protocolParent || p.some(key => ['messages','input','output','tool_calls','content'].includes(key));
  }
  if (field === 'id') return protocolParent || p.includes('tool_calls') || root && (/^(?:resp_|msg_|chatcmpl-|chat_|item_|call_|toolu_|fc_)/.test(token.value) || Array.isArray(parsed.choices) || Array.isArray(parsed.output));
  if (['type','role','model','object'].includes(field)) return root || protocolParent || p.includes('tool_calls');
  if (field === 'name') return (parent?.type && /^(?:function|function_call|tool_use|tool_result|custom_tool_call)$/.test(parent.type)) ||
    p.at(-2) === 'function';
  return false;
}

function protocolSignature(token, parsed, depth) {
  const key = normalize(token.field);
  if (!['signature','thoughtsignature'].includes(key) || depth || token.numeric || !/^[A-Za-z0-9+/=_-]+$/.test(token.value)) return false;
  let p = token.path, root = parsed;
  if (p[0] === 'response') { p = p.slice(1); root = parsed.response; }
  const parent = p.slice(0, -1).reduce((obj, key) => obj?.[key], root);
  if (key === 'signature') {
    if (p.length === 2 && p[0] === 'delta' && root?.type === 'content_block_delta' && parent?.type === 'signature_delta') return true;
    if (parent?.type !== 'thinking') return false;
    if (p.length === 2 && p[0] === 'content_block' && root?.type === 'content_block_start') return true;
    if (p.length === 3 && p[0] === 'content' && Number.isInteger(p[1]) && (root?.role === 'assistant' || root?.type === 'message')) return true;
    if (p.length === 4 && p[0] === 'message' && p[1] === 'content' && Number.isInteger(p[2]) && root?.message?.role === 'assistant') return true;
    return p.length === 5 && p[0] === 'messages' && Number.isInteger(p[1]) && p[2] === 'content' && Number.isInteger(p[3]) && root?.messages?.[p[1]]?.role === 'assistant';
  }
  return geminiPartPath(p.slice(0,-1));
}

const mediaFields = new Set(['image','imageurl','audio','audiourl','video','videourl','document','file','fileurl','filedata','inlinedata']);
const mediaValues = new Set(['data','image','audio','video','document','file','imageurl','audiourl','videourl','fileurl']);
const opaqueFields = new Set(['encryptedcontent','signature','thoughtsignature','encrypteddata','ciphertext','b64json','base64','imagedata','audiodata','filedata','fileid','fileuri','gcsuri']);
const mediaType = /^(?:(?:input|output)_)?(?:image(?:_url)?|audio(?:_url)?|video(?:_url)?|document|file)$/;

function assertInspectable(token, parsed, depth = 0) {
  const key = normalize(token.field), value = token.value;
  if (typeof value !== 'string' || !value) return '';
  // Only known vendor protocol paths may pass through; callers must withhold warned masked copies from export.
  if (protocolSignature(token, parsed, depth)) return 'OPAQUE_SIGNATURE';
  if (opaqueFields.has(key) || /^data:[^,]*;base64,/i.test(value) || key === 'url' && /^(?:blob:|file:|data:)/i.test(value)) throw new Error('UNINSPECTABLE_CONTENT');
  if (!mediaValues.has(key) && !['url','uri'].includes(key)) return '';
  let node = parsed, media = false;
  for (const field of token.path.slice(0, -1)) {
    if (mediaFields.has(normalize(field)) || node && typeof node === 'object' && mediaType.test(node.type || '')) media = true;
    node = node?.[field];
  }
  if (node && typeof node === 'object' && (mediaType.test(node.type || '') || node.mime_type || node.mimeType)) media = true;
  if ((mediaValues.has(key) || media && ['url','uri'].includes(key)) &&
      (/^(?:https?:|blob:|file:|data:|gs:|s3:)/i.test(value) || (value.length >= 80 && /^[A-Za-z0-9+/=_-]+$/.test(value)) || media && key === 'data')) {
    throw new Error('UNINSPECTABLE_CONTENT');
  }
  return '';
}

function replacePrivateKeys(text, placeholder) {
  const begin = /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----/g;
  const parts = []; let cursor = 0;
  for (let match; (match = begin.exec(text));) {
    const marker = '-----END ' + match[1] + '-----', end = text.indexOf(marker, begin.lastIndex);
    if (end < 0) throw new Error('INCOMPLETE_PRIVATE_KEY');
    const next = end + marker.length;
    parts.push(text.slice(cursor, match.index), placeholder('secret', text.slice(match.index, next)));
    cursor = begin.lastIndex = next;
  }
  if (!parts.length) return text;
  parts.push(text.slice(cursor)); return parts.join('');
}

function replacePatterns(value, policy, placeholder) {
  let text = value;
  if (policy.secret) {
    text = replacePrivateKeys(text, placeholder);
    text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]{15,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|demo_secret_[A-Za-z0-9_]+)\b/g, match => placeholder('secret', match));
    text = text.replace(/\b((?:Bearer|Basic)\s+)([A-Za-z0-9._~+/-]{8,}=*)/gi, (_all, prefix, value) => prefix + placeholder('secret', value));
    text = text.replace(/(^|[\r\n])((?:Cookie|Set-Cookie):[\t ]*)([^\r\n]+)/gi, (_all, line, prefix, value) => line + prefix + placeholder('secret', value));
    text = text.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/@]{1,1024}@)/gi, (_all, scheme, auth) => scheme + placeholder('secret', auth.slice(0, -1)) + '@');
    text = text.replace(/((?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|cookie|otp|pin|cvv|验证码|密码|密钥)["']?[\t ]{0,8}[:=：][\t ]{0,8}["']?)([^\s"'&,;<>]{1,4096})/gi,
      (_all, prefix, secret) => prefix + placeholder('secret', secret));
  }
  if (policy.identity) {
    text = text.replace(/(?<![A-Za-z0-9])(?:[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]|[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3})(?![A-Za-z0-9])/g,
      match => isIdentityCard(match, 'zh-CN') ? placeholder('identity', match) : match);
    text = text.replace(/(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/g, match => placeholder('identity', match));
  }
  if (policy.financial) {
    text = text.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, match => isIBAN(match) ? placeholder('financial', match) : match);
    text = text.replace(/(?<![\w])\d(?:[ -]?\d){12,18}(?![\w])/g, match => isCreditCard(match) ? placeholder('financial', match) : match);
  }
  if (policy.ip) {
    text = text.replace(/(?<![\w:])(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9:.]{0,45}(?:%[A-Za-z0-9_.-]{1,32})?(?![\w:])/g, match => isIP(match.split('%')[0], 6) ? placeholder('ip', match) : match);
    text = text.replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, match => placeholder('ip', match));
  }
  if (policy.device) text = text.replace(/\b(?:[A-Fa-f0-9]{2}[:-]){5}[A-Fa-f0-9]{2}\b/g, match => placeholder('device', match));
  if (policy.phone) text = text.replace(/(?<![\w])\+?\d[\d ()-]{6,}\d(?![\w])/g, match => placeholder('phone', match));
  // Labels handle identifiers without universal syntax, including deliberately invalid/test IDs.
  const labels = /((?:身份证(?:号|号码)?|证件号|护照(?:号|号码)?|社保号|税号|passport|ssn|national[_ ]?id|银行卡(?:号)?|银行账号|收款账号|iban|card[_ ]?number|姓名|名字|住址|地址|出生日期|生日|经度|纬度|imei|imsi|微信号|qq号)["']?[\t ]{0,8}[:=：][\t ]{0,8}["']?)([^\s"'，。；;<>]{1,256})/gi;
  text = text.replace(labels, (all, prefix, sensitive) => {
    const label = prefix.split(/[:=：]/)[0].replace(/["']/g, '').trim(), kind = fieldKind(label, policy);
    return kind ? prefix + placeholder(kind, sensitive) : all;
  });
  return text;
}

module.exports = { REDACTION_VERSION, redactionPolicyHash, fieldKind, protocolField, assertInspectable, replacePatterns };
