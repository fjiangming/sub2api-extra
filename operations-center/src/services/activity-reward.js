'use strict';

// Both marker versions are authored by the activity service. The code length changed
// when the service moved from the legacy 48-hex contract to the current 28-hex one.
const ACTIVITY_CODE_RE = /^AC-[a-f0-9]{28}$|^AC-[a-f0-9]{48}$/;
const ACTIVITY_NOTE_RE = /^活动奖励(?:补贴)?; activity=recharge-lottery; reward=[a-f0-9-]{36}; batch=[a-f0-9-]{36}(?:;|$)/;

function isActivityReward(document) {
  return document.origin === 'redeem' &&
    ['balance', 'admin_balance', 'affiliate_balance'].includes(document.redeemType) &&
    ACTIVITY_CODE_RE.test(document.code || '') && ACTIVITY_NOTE_RE.test(document.note || '');
}

// PostgreSQL uses the same contract as isActivityReward when a historical reward
// must be aggregated without first importing every redemption into the local store.
function activityRewardSql(alias = 'r') {
  return `${alias}.type IN ('balance', 'admin_balance', 'affiliate_balance')
    AND COALESCE(to_jsonb(${alias})->>'code', '') ~ '^(AC-[a-f0-9]{28}|AC-[a-f0-9]{48})$'
    AND COALESCE(${alias}.notes, '') ~ '^活动奖励(补贴)?; activity=recharge-lottery; reward=[a-f0-9-]{36}; batch=[a-f0-9-]{36}(;|$)'`;
}

module.exports = { isActivityReward, activityRewardSql };
