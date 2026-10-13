'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const AVATARS = ['mountain', 'lake', 'night', 'forest', 'hills', 'sea', 'peak', 'valley', 'coast', 'green'];
const emailAddress = z.string().trim().max(254).email();

function maskEmail(email) {
  const parsed = emailAddress.safeParse(email);
  if (!parsed.success) return null;
  const [local, domain] = parsed.data.split('@');
  const base = local.split('+')[0];
  // Always hide at least one character; fixed padding also hides the local-part length.
  const visible = base.length > 2 ? 2 : base.length === 2 ? 1 : 0;
  return `${base.slice(0, visible)}***@${domain.toLowerCase()}`;
}

function publicIdentity(id, email) {
  const key = crypto.createHash('sha256').update(`usage-leaderboard:${id}`).digest('hex').slice(0, 16);
  return {
    key,
    name: maskEmail(email) || `创造者 ${key.slice(0, 6).toUpperCase()}`,
    avatar: AVATARS[parseInt(key.slice(0, 4), 16) % AVATARS.length]
  };
}

module.exports = { publicIdentity, maskEmail };
