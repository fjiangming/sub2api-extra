const dns = require('dns').promises;
const net = require('net');
const ipaddr = require('ipaddr.js');
const { AppError } = require('../errors');

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data.ec2.internal'
]);

const BLOCKED_IPV4 = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200'
]);

function normalizedIp(address) {
  const value = String(address || '').replace(/^\[|\]$/g, '').split('%')[0];
  try {
    const parsed = ipaddr.parse(value);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
      return parsed.toIPv4Address();
    }
    return parsed;
  } catch {
    return null;
  }
}

function isPrivateIp(address) {
  const parsed = normalizedIp(address);
  if (!parsed) return false;
  if (parsed.kind() === 'ipv4' && BLOCKED_IPV4.has(parsed.toString())) return true;
  return parsed.range() !== 'unicast';
}

function hostMatches(hostname, patterns) {
  const host = hostname.toLowerCase();
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    if (normalized.startsWith('*.')) {
      return host.endsWith(normalized.slice(1));
    }
    return host === normalized;
  });
}

async function resolveSafeUrl(input, config) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new AppError('INVALID_URL', 'Provider URL is invalid', { status: 400 });
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError('SSRF_BLOCKED', 'Only HTTP and HTTPS provider URLs are allowed', {
      status: 400
    });
  }
  if (url.username || url.password) {
    throw new AppError('SSRF_BLOCKED', 'Credentials in provider URLs are not allowed', {
      status: 400
    });
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_IPV4.has(hostname)) {
    throw new AppError('SSRF_BLOCKED', 'Cloud metadata endpoints are blocked', {
      status: 400
    });
  }

  const allowedHosts = config.allowedHosts || [];
  const explicitlyAllowed = hostMatches(hostname, allowedHosts);
  const privateHostsRestricted = allowedHosts.length > 0 && !config.allowPrivateNetworks;
  const directIp = net.isIP(hostname);
  const addresses = directIp
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true }).catch((error) => {
        throw new AppError('DNS_FAILED', `Unable to resolve provider host ${hostname}`, {
          status: 502,
          retryable: true,
          cause: error
        });
      });

  for (const item of addresses) {
    if (BLOCKED_IPV4.has(item.address)) {
      throw new AppError('SSRF_BLOCKED', 'Cloud metadata endpoints are blocked', {
        status: 400
      });
    }
    if (
      isPrivateIp(item.address) &&
      privateHostsRestricted &&
      !explicitlyAllowed
    ) {
      throw new AppError(
        'SSRF_BLOCKED',
        `Private provider host ${hostname} is not in PROVIDER_MONITOR_ALLOWED_HOSTS`,
        { status: 400 }
      );
    }
  }

  return {
    url,
    hostname,
    addresses: addresses.map((item) => ({
      address: item.address,
      family: Number(item.family || net.isIP(item.address))
    }))
  };
}

async function assertSafeUrl(input, config) {
  return (await resolveSafeUrl(input, config)).url;
}

module.exports = {
  assertSafeUrl,
  resolveSafeUrl,
  isPrivateIp,
  hostMatches
};
