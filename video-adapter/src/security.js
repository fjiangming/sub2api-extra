'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const ipaddr = require('ipaddr.js');
const { ensure } = require('./errors');

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function secretEqual(a, b) { return crypto.timingSafeEqual(Buffer.from(hash(String(a))), Buffer.from(hash(String(b)))); }
function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function decrypt(value, key) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
}
function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
function secureLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) return callback(new Error('Upstream DNS resolved to a forbidden address'));
    const eligible = options.family ? addresses.filter(a => a.family === options.family) : addresses;
    if (!eligible.length) return callback(new Error('No allowed address for the requested family'));
    if (options.all) return callback(null, eligible);
    callback(null, eligible[0].address, eligible[0].family);
  });
}
function safeUrl(value, allowedHosts) {
  const url = new URL(value);
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'UNSAFE_URL', 'Unsafe upstream URL', 502);
  ensure(!url.port || url.port === '443', 'UNSAFE_URL', 'Only HTTPS port 443 is supported', 502);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  ensure(allowedHosts.includes(host), 'UNSAFE_URL', 'Upstream hostname is not explicitly allowed', 502);
  ensure(!ipaddr.isValid(host) || publicAddress(host), 'UNSAFE_URL', 'Private upstream addresses are forbidden', 502);
  return url;
}
function matchesIp(address, rule) {
  try {
    const ip = ipaddr.process(address);
    const [network, bits] = rule.includes('/') ? ipaddr.parseCIDR(rule) : [ipaddr.process(rule), ipaddr.process(rule).kind() === 'ipv4' ? 32 : 128];
    return ip.kind() === network.kind() && ip.match(network, bits);
  } catch { return false; }
}
function checkIp(key, address) {
  const deny = key.ip_blacklist || [];
  const allow = key.ip_whitelist || [];
  ensure(!deny.some(rule => matchesIp(address, rule)) && (!allow.length || allow.some(rule => matchesIp(address, rule))), 'IP_DENIED', 'API key IP policy denied this request', 403);
}

module.exports = { hash, secretEqual, encrypt, decrypt, publicAddress, secureLookup, safeUrl, checkIp };
