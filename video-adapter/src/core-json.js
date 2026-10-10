'use strict';

// Native JSONB may contain numeric prices; retain their original decimal text.
const monetaryKeys = /^(?:quota|quota_used|usage_(?:5h|1d|7d)|rate_limit_(?:5h|1d|7d)|(?:video_|peak_)?rate_multiplier|video_price_.*|per_request_price|profit_min_margin|profit_safety_buffer|480p|720p|1080p|2k|4k)$/;
function parseCoreJson(source) {
  return JSON.parse(source, (key,value,context) => {
    if (typeof value==='number' && (monetaryKeys.test(key) || ['id','user_id','group_id'].includes(key))) return context.source;
    return value;
  });
}

module.exports = { parseCoreJson };
