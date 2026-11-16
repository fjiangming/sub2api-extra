'use strict';

const { isActivityReward } = require('./activity-reward');

function isSubsidyCredit(document) {
  return document.origin === 'redeem' && ['balance', 'admin_balance'].includes(document.redeemType) &&
    String(document.note || '').startsWith('[补贴]');
}

function isNonRechargeCredit(document) {
  return isActivityReward(document) || isSubsidyCredit(document);
}

module.exports = { isSubsidyCredit, isNonRechargeCredit };
