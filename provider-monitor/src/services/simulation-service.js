const { AppError } = require('../errors');
const { nowIso } = require('../db');

function compactNumber(value) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
}

function publicRechargeResult(recharge) {
  if (!recharge) return null;
  let targetHost = null;
  try {
    targetHost = new URL(recharge.url).hostname;
  } catch {}
  return {
    mode: recharge.mode,
    reason: recharge.reason || null,
    errorCode: recharge.errorCode || null,
    expiresAt: recharge.expiresAt || null,
    targetHost
  };
}

class SimulationService {
  constructor({ providers, notifications }) {
    this.providers = providers;
    this.notifications = notifications;
  }

  async rechargeAlert(input) {
    const provider = this.providers.get(input.connectionId);
    if (!provider.rechargeUrl) {
      throw new AppError('RECHARGE_URL_MISSING', '该供应商尚未配置有效的充值链接', {
        status: 409
      });
    }
    const channel = this.notifications.listChannels()
      .find((item) => item.id === input.channelId);
    if (!channel) {
      throw new AppError('CHANNEL_NOT_FOUND', 'Notification channel was not found', {
        status: 404
      });
    }

    const configuredThreshold = provider.warning_threshold == null
      ? null
      : Number(provider.warning_threshold);
    const threshold = Number.isFinite(configuredThreshold) ? configuredThreshold : 20;
    const balance = threshold > 0 ? threshold / 2 : 0;
    const currency = provider.threshold_currency || 'USD';
    const thresholdLabel = configuredThreshold == null ? '模拟预警值' : '预警值';
    const triggeredAt = nowIso();
    const event = {
      id: null,
      connection_id: provider.id,
      severity: 'warning',
      message: `[模拟测试] ${provider.name} 余额为 ${compactNumber(balance)} ${currency}，已低于或等于${thresholdLabel} ${compactNumber(threshold)} ${currency}。`,
      triggered_at: triggeredAt,
      details: {
        test: true,
        simulation: 'recharge_alert',
        connectionId: provider.id,
        providerName: provider.name,
        adapterType: provider.adapter_type,
        balance,
        threshold,
        thresholdConfigured: configuredThreshold != null,
        currency,
        rechargeUrl: provider.rechargeUrl
      }
    };
    const sent = await this.notifications.testRechargeAlert(channel.id, event);
    return {
      testType: 'recharge_alert',
      status: sent.delivery.status,
      simulated: true,
      sentAt: triggeredAt,
      provider: {
        id: provider.id,
        name: provider.name,
        adapterType: provider.adapter_type
      },
      channel: {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        enabled: channel.enabled
      },
      alert: {
        severity: event.severity,
        balance,
        threshold,
        thresholdConfigured: configuredThreshold != null,
        currency
      },
      recharge: publicRechargeResult(sent.recharge)
    };
  }
}

module.exports = {
  SimulationService,
  publicRechargeResult
};
