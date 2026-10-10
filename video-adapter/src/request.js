'use strict';

const { z } = require('zod');
const { ensure } = require('./errors');
const { publicAddress } = require('./security');
const ipaddr = require('ipaddr.js');

const referenceSchema = z.object({
  type: z.enum(['image', 'video', 'audio']), source: z.string().min(1).max(12000000),
  role: z.enum(['reference', 'first_frame', 'last_frame']).default('reference'),
  duration_seconds: z.number().positive().max(600).optional()
}).strict();
const requestSchema = z.object({
  model: z.string().min(1).max(100), prompt: z.string().min(1).max(20000),
  duration: z.number().int().min(1).max(600).optional(), seconds: z.number().int().min(1).max(600).optional(),
  resolution: z.string().optional(), aspect_ratio: z.string().optional(), ratio: z.string().optional(),
  references: z.array(referenceSchema).max(100).default([])
}).strict();

function normalizeRequest(input, model) {
  const value = requestSchema.parse(input);
  ensure(value.duration == null || value.seconds == null || value.duration === value.seconds, 'PARAMETER_CONFLICT', 'duration and seconds disagree');
  ensure(!value.ratio || !value.aspect_ratio || value.ratio === value.aspect_ratio, 'PARAMETER_CONFLICT', 'ratio and aspect_ratio disagree');
  const result = { model: value.model, prompt: value.prompt, duration: value.duration ?? value.seconds ?? model.defaultDuration,
    resolution: (value.resolution || model.resolutions[0]).toLowerCase(), aspect_ratio: value.aspect_ratio || value.ratio || model.aspectRatios[0], references: value.references };
  ensure(result.duration >= model.minDuration && result.duration <= model.maxDuration && (!model.durations || model.durations.includes(result.duration)), 'DURATION_UNSUPPORTED', 'Requested duration is not an accepted model specification');
  ensure(model.resolutions.includes(result.resolution), 'RESOLUTION_UNSUPPORTED', 'Unsupported resolution');
  ensure(model.aspectRatios.includes(result.aspect_ratio), 'ASPECT_RATIO_UNSUPPORTED', 'Unsupported aspect ratio');
  ensure(result.references.length <= model.maxReferences.total, 'REFERENCE_LIMIT', 'Too many references');
  ensure(!result.references.length || model.cost.referencesIncluded, 'REFERENCE_COST_UNVERIFIED', 'Supplier cost card has not confirmed reference-media costs');
  for (const type of ['image', 'video', 'audio']) ensure(result.references.filter(r => r.type === type).length <= model.maxReferences[type], 'REFERENCE_LIMIT', `Too many ${type} references`);
  for (const ref of result.references) {
    if (ref.source.startsWith('data:')) {
      ensure(ref.type === 'image' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(ref.source), 'INVALID_REFERENCE', 'Invalid image data URI');
    } else {
      let url;
      try { url = new URL(ref.source); } catch { ensure(false, 'INVALID_REFERENCE', 'Invalid reference URL'); }
      ensure(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase()), 'INVALID_REFERENCE', 'References require public HTTPS URLs');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      ensure(!ipaddr.isValid(host) || publicAddress(host), 'INVALID_REFERENCE', 'Private reference addresses are forbidden');
    }
  }
  return result;
}

module.exports = { normalizeRequest };
