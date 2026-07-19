const { ProviderAdapter, joinUrl, toFiniteNumber, toIsoDate, unwrapEnvelope, extractItems } = require('./base');

class VoApiV2Adapter extends ProviderAdapter {
  capabilities() {
    return {
      ...super.capabilities(),
      accountBalance: true,
      listKeys: true,
      keyQuota: true,
      listGroups: true,
      keyGroup: true,
      credentialRefresh: false,
      checkIn: true
    };
  }

  headers() {
    const token = this.credentials.accessToken || this.credentials.apiKey;
    return {
      Accept: 'application/json',
      Authorization: this.connection.type_config_json?.bearerToken ? `Bearer ${token}` : token,
      'voapi-user': this.connection.remote_user_id || this.credentials.userId
    };
  }

  async request(endpoint) {
    const response = await this.http.requestJson(joinUrl(this.connection.base_url, endpoint), {
      headers: this.headers(),
      retries: 0
    });
    return unwrapEnvelope(response.data);
  }

  async getUserInfo() {
    if (!this.userInfo) this.userInfo = await this.request('/api/user/info');
    return this.userInfo;
  }

  async getAccount() {
    const user = await this.getUserInfo();
    return {
      remoteId: String(user.id || this.connection.remote_user_id || this.connection.id),
      displayName: user.nickname || user.username || user.email || this.connection.name,
      userGroup: user.levelName || null,
      status: user.enable === false ? 'disabled' : 'active',
      metadata: this.safeRaw({ email: user.email, level: user.level })
    };
  }

  async getAccountBalances(account) {
    const user = await this.getUserInfo();
    const available =
      (toFiniteNumber(user.basicBalance, 0) || 0) +
      (toFiniteNumber(user.bindBalance, 0) || 0);
    const used =
      (toFiniteNumber(user.usedBasicBalance, 0) || 0) +
      (toFiniteNumber(user.usedBindBalance, 0) || 0);
    return [
      {
        scope: 'account',
        remoteSubjectId: account?.remoteId || this.connection.id,
        currency: user.currency || 'USD',
        available,
        total: available + used,
        used,
        granted: toFiniteNumber(user.bindBalance),
        toppedUp: toFiniteNumber(user.basicBalance),
        frozen: null,
        unlimited: false,
        sourceField: 'basicBalance + bindBalance',
        raw: this.safeRaw(user)
      }
    ];
  }

  async getTemplate() {
    return this.request('/api/keys/template');
  }

  async listGroups() {
    const template = await this.getTemplate();
    return (template.groups || []).map((group) => ({
      remoteId: String(group.id),
      type: 'key_route_group',
      name: group.name || String(group.id),
      ratio: toFiniteNumber(group.ratio),
      status: group.enable === false ? 'disabled' : 'active',
      metadata: this.safeRaw(group)
    }));
  }

  async listKeys() {
    const template = await this.getTemplate();
    const items = [];
    const pageSize = 100;
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request(
        `/api/keys?page=${page}&size=${pageSize}&sl[name]=true&sl[token]=true&sl[note]=true`
      );
      const pageResult = extractItems(response).items;
      items.push(...pageResult);
      if (pageResult.length < pageSize) break;
    }
    const groupNames = new Map(
      (template.groups || []).map((group) => [String(group.id), group.name || String(group.id)])
    );
    return items.map((key, index) => {
      const groups = (key.groups || []).map(String);
      const unlimited = key.boundlessAmount === true;
      const remaining = toFiniteNumber(key.amount);
      const used = toFiniteNumber(key.used, 0);
      return {
        remoteId: String(key.id || index),
        name: key.name || `VoAPI Key ${index + 1}`,
        maskedKey: key.tokenMasked || '',
        status: key.enable === false ? 'disabled' : 'enabled',
        primaryGroupRef: groups[0] || null,
        backupGroupRef: null,
        additionalGroupRefs: groups.slice(1),
        quota: {
          currency: key.currency || 'USD',
          limit: unlimited || remaining == null ? null : remaining + used,
          used,
          remaining: unlimited ? null : remaining,
          unlimited,
          resetAt: null,
          resetInterval: null
        },
        expiresAt: toIsoDate(key.expireTime),
        lastUsedAt: toIsoDate(key.lastUsedAt),
        metadata: this.safeRaw({
          note: key.note,
          groups: groups.map((id) => ({ id, name: groupNames.get(id) || id }))
        })
      };
    });
  }

  async getCheckInStatus() {
    const data = await this.request('/api/check_in/stats');
    return {
      supported: true,
      checkedInToday: Boolean(data?.todaySigned),
      details: this.safeRaw(data)
    };
  }

  async checkIn() {
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url, '/api/check_in'),
      { method: 'POST', headers: this.headers(), retries: 0 }
    );
    const data = unwrapEnvelope(response.data);
    return {
      status: 'succeeded',
      rewardAmount: toFiniteNumber(data?.amount ?? data?.bonusAmount),
      currency: data?.currency || 'USD',
      details: this.safeRaw(data)
    };
  }
}

module.exports = {
  VoApiV2Adapter
};
