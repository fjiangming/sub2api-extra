'use strict';

function publicOrigins(primary, aliases, variable, production = false) {
  const origins = primary ? [new URL(primary).origin] : [];
  for (const entry of String(aliases || '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*') ||
          /\s/.test(value) || (production && url.protocol !== 'https:')) throw new Error();
      origins.push(url.origin);
    } catch {
      throw new Error(`${variable}: expected comma-separated HTTP(S) origins; production requires HTTPS`);
    }
  }
  return [...new Set(origins)];
}

module.exports = { publicOrigins };
