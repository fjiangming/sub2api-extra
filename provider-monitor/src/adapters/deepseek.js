const { ProviderAdapter, joinUrl, toFiniteNumber } = require('./base');
const { AppError } = require('../errors');

class DeepSeekAdapter extends ProviderAdapter {
  capabilities() {
    return {
      ...super.capabilities(),
      accountBalance: true,
      multiCurrencyBalance: true
    };
  }

  headers() {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.credentials.apiKey}`
    };
  }

  async getBalanceResponse() {
    if (this.balanceResponse) return this.balanceResponse;
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url || 'https://api.deepseek.com', '/user/balance'),
      { headers: this.headers() }
    );
    if (!Array.isArray(response.data?.balance_infos)) {
      throw new AppError('SCHEMA_MISMATCH', 'DeepSeek response did not include balance_infos', {
        status: 502
      });
    }
    this.balanceResponse = response.data;
    return this.balanceResponse;
  }

  async getAccount() {
    const data = await this.getBalanceResponse();
    return {
      remoteId: this.connection.account_dedupe_key || this.connection.id,
      displayName: this.connection.name,
      userGroup: null,
      status: data.is_available === false ? 'disabled' : 'active',
      metadata: { isAvailable: data.is_available }
    };
  }

  async getAccountBalances(account) {
    const data = await this.getBalanceResponse();
    return data.balance_infos.map((info) => ({
      scope: 'account',
      remoteSubjectId: account?.remoteId || this.connection.id,
      currency: info.currency || 'CNY',
      available: toFiniteNumber(info.total_balance, 0),
      total: null,
      used: null,
      granted: toFiniteNumber(info.granted_balance, 0),
      toppedUp: toFiniteNumber(info.topped_up_balance, 0),
      frozen: null,
      unlimited: false,
      sourceField: 'balance_infos[].total_balance',
      raw: this.safeRaw(info)
    }));
  }
}

module.exports = {
  DeepSeekAdapter
};
