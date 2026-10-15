'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const emailAddress = z.string().trim().max(254).email();

function avatarUrl(value, baseUrl) {
  if (typeof value !== 'string') return null;
  const avatar = value.trim();
  if (!avatar || avatar.length > 30000) return null;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i.test(avatar)) return avatar;
  if (!/^https?:\/\//i.test(avatar) && !/^\/(?!\/)/.test(avatar)) return null;
  try {
    const url = new URL(avatar, baseUrl);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function maskEmail(email) {
  const parsed = emailAddress.safeParse(email);
  if (!parsed.success) return null;
  const [local, domain] = parsed.data.split('@');
  const base = local.split('+')[0];
  // Always hide at least one character; fixed padding also hides the local-part length.
  const visible = base.length > 2 ? 2 : base.length === 2 ? 1 : 0;
  return `${base.slice(0, visible)}***@${domain.toLowerCase()}`;
}

function publicIdentity(id, email, avatar, baseUrl) {
  const key = crypto.createHash('sha256').update(`usage-leaderboard:${id}`).digest('hex').slice(0, 16);
  return {
    key,
    name: maskEmail(email) || `创造者 ${key.slice(0, 6).toUpperCase()}`,
    avatar: avatarUrl(avatar, baseUrl)
  };
}

module.exports = { publicIdentity, maskEmail, avatarUrl };
