'use strict';

const { randomBytes } = require('node:crypto');

function creditCode() { return `AC-${randomBytes(14).toString('hex')}`; }
function creditNotes(row) { return `活动奖励补贴; activity=recharge-lottery; reward=${row.id}; batch=${row.batch_id}`; }
function legacyNotes(row) { return `活动奖励; activity=recharge-lottery; reward=${row.id}; batch=${row.batch_id}`; }
function legacyCredit(row) {
  return /^AC-[a-f0-9]{48}$/.test(row.credit_code) && ['balance','affiliate_balance'].includes(row.credit_type) && row.credit_notes === legacyNotes(row);
}

module.exports = { creditCode, creditNotes, legacyNotes, legacyCredit };
