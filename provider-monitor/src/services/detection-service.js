const { AppError, asAppError } = require('../errors');

function payloadText(payload) {
  try {
    return JSON.stringify(payload?.data ?? payload ?? {}).toLowerCase();
  } catch {
    return '';
  }
}

class DetectionService {
  constructor({ http }) {
    this.http = http;
  }

  async detect(baseUrl) {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new AppError('INVALID_URL', 'Provider URL is invalid', { status: 400 });
    }
    const suggestions = new Map();
    const probes = [];
    const add = (adapterType, confidence, evidence) => {
      const existing = suggestions.get(adapterType);
      if (!existing || confidence > existing.confidence) {
        suggestions.set(adapterType, { adapterType, confidence, evidence });
      }
    };
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com')) {
      add('deepseek', 0.99, 'official_hostname');
    }
    if (hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')) {
      add('openrouter', 0.99, 'official_hostname');
    }

    const probe = async (pathname) => {
      try {
        const response = await this.http.requestJson(new URL(pathname, `${url.toString().replace(/\/+$/, '')}/`).toString(), {
          retries: 0,
          timeoutMs: 5000,
          maxResponseBytes: 256 * 1024
        });
        probes.push({ path: pathname, status: 'succeeded', httpStatus: response.status });
        return response.data;
      } catch (error) {
        const appError = asAppError(error);
        probes.push({ path: pathname, status: 'failed', code: appError.code });
        return null;
      }
    };

    if (![...suggestions.values()].some((item) => item.confidence >= 0.95)) {
      const status = await probe('/api/status');
      const text = payloadText(status).replace(/[\s_-]+/g, '');
      if (text.includes('veloera')) add('veloera', 0.95, 'api_status_name');
      else if (text.includes('donehub')) add('done-hub', 0.95, 'api_status_name');
      else if (text.includes('onehub')) add('one-hub', 0.95, 'api_status_name');
      else if (text.includes('newapi')) add('new-api', 0.9, 'api_status_name');
      else if (text.includes('oneapi')) add('one-api', 0.9, 'api_status_name');
      else if (status && /quota_per_unit/i.test(JSON.stringify(status))) {
        add('new-api', 0.58, 'one_api_family_status_contract');
        add('one-api', 0.52, 'one_api_family_status_contract');
        add('one-hub', 0.45, 'one_api_family_status_contract');
        add('done-hub', 0.45, 'one_api_family_status_contract');
      }
      if (text.includes('voapi')) add('voapi-v2', 0.85, 'api_status_name');
    }

    if (suggestions.size === 0) {
      const health = await probe('/health/liveliness');
      const text = payloadText(health);
      if (health && (text.includes('litellm') || text.includes('healthy') || text.includes('connected'))) {
        add('litellm', text.includes('litellm') ? 0.9 : 0.6, 'litellm_health_contract');
      }
    }

    if (suggestions.size === 0) {
      const health = await probe('/health');
      const text = payloadText(health).replace(/[\s_-]+/g, '');
      if (text.includes('sub2api')) add('sub2api', 0.9, 'health_service_name');
    }

    if (suggestions.size === 0) add('custom', 0.2, 'no_known_public_contract');
    const items = [...suggestions.values()].sort((left, right) => right.confidence - left.confidence);
    return {
      baseUrl: url.toString().replace(/\/+$/, ''),
      recommended: items[0],
      ambiguous: items.length > 1 && items[0].confidence - items[1].confidence < 0.15,
      suggestions: items,
      probes
    };
  }
}

module.exports = { DetectionService, payloadText };
