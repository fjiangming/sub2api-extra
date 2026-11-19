'use strict';

const { default: isMobilePhone } = require('validator/lib/isMobilePhone');
const ipaddr = require('ipaddr.js');

function credentialValue(value, label = '') {
  const text = value.trim();
  if (!text || /^(?:[.=*-]+|\$(?:[A-Za-z_]\w*|\{[^\r\n]*\})|<[^>]*>|\{\{[^}]*\}\})$/.test(text)) return false;
  if (/^(?:PWD|OLDPWD)$/.test(label) && /^(?:\/|[A-Za-z]:[\\/])/.test(text)) return false;
  if (/^(?:cookie|set-cookie)$/i.test(label) && !text.split(';').some(part => {
    const equal = part.indexOf('='); return equal >= 0 && credentialValue(part.slice(equal + 1));
  })) return false;
  return true;
}

function machineNumber(text, at, value) {
  const before = text.slice(Math.max(0, at - 160), at), after = text.slice(at + value.length, at + value.length + 32);
  if (/[\w./:-]$/.test(before) || /^[\w./:-]/.test(after) || /[\t\r\n]| {2,}/.test(value)) return true;
  if (/\d[\t ]{2,}$/.test(before) || /^[\t ]{2,}\d/.test(after)) return true;
  if (/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/.test(value)) return true;
  const option = before.match(/--([\w-]+)=[^\s]*$/);
  if (option && !/(?:phone|mobile|card|account)/i.test(option[1])) return true;
  return /(?:[?&](?:page_?id|id|offset|limit|timestamp|size)|\b(?:pid|ppid|bytes|size|timestamp|epoch|port|offset|limit))\s*[:=]\s*$/i.test(before) ||
    /^\s*(?:bytes|[KMGT]i?B)\b/i.test(after);
}

function phoneCandidate(value, at, text) {
  if (machineNumber(text, at, value)) return false;
  const compact = value.replace(/[ ()-]/g, '');
  if (!/^\+?\d{7,15}$/.test(compact)) return false;
  // Unlabelled numbers require a valid phone shape; explicit phone fields are handled separately.
  return /^\+[1-9]\d{7,14}$/.test(compact) || /^0\d{2,3}[- ]\d{7,8}$/.test(value) || isMobilePhone(compact, 'any');
}

function privateAddress(value) {
  try { return !['loopback','unspecified'].includes(ipaddr.process(value.split('%')[0]).range()); }
  catch { return false; }
}

function technicalNumber(label, value) {
  return /^(?:id|page_?id|pid|ppid|offset|limit|timestamp|epoch|size|bytes|port)$/i.test(String(label)) && /^\d+$/.test(value);
}

function contextualFieldKind(token, parsed, kind) {
  if (kind === 'secret' && !credentialValue(token.value, String(token.field))) return '';
  if (kind === 'ip' && !privateAddress(token.value)) return '';
  if (kind === 'identity' && token.field === 'id' && /^\d+$/.test(token.value)) {
    const parent = token.path.slice(0, -1).reduce((node, key) => node?.[key], parsed);
    const person = token.path.some(key => /^(?:customer|patient|person|employee|user|contact)s?$/i.test(String(key))) ||
      parent && Object.keys(parent).some(key => /^(?:full_?name|real_?name|email|phone|passport|ssn|id_?card)$/i.test(key));
    if (!person) return '';
  }
  return kind;
}

module.exports = { credentialValue, machineNumber, phoneCandidate, privateAddress, contextualFieldKind, technicalNumber };
