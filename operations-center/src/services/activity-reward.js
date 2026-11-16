'use strict';

// Both markers are authored by the activity service; ordinary balance credits retain their existing treatment.
function isActivityReward(document) {
  return document.origin === 'redeem' && document.redeemType === 'balance' &&
    /^AC-[a-f0-9]{48}$/.test(document.code || '') &&
    /^活动奖励; activity=recharge-lottery; reward=[a-f0-9-]{36}; batch=[a-f0-9-]{36}$/.test(document.note || '');
}

module.exports = { isActivityReward };
