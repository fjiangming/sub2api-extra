'use strict';

const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const { AppError } = require('../errors');
const { hash } = require('./billing-import-csv');

const conflict = message => new AppError('IMPORT_REVIEW_REQUIRED', message, { status: 409 });
const started = row => row.case_id || ['confirming', 'failed', 'settled'].includes(row.status);
const quoteSignature = usage => hash(Object.keys(usage).sort().filter(key =>
  !['ID', 'RequestID', 'CreatedAt', 'UpstreamRequestID'].includes(key)).map(key => [key, usage[key]]));

function nativeSource(row, candidate) {
  return { account_id: Number(candidate.accountId), bill_identity: row.record.identity,
    payload_digest: hash([candidate.reference, row.record.tokens]), user_id: Number(candidate.userId), api_key_id: Number(candidate.apiKeyId),
    started_at: new Date(candidate.startMs).toISOString(), model: row.record.model,
    upstream_request_id: row.record.requestId || '', evidence: 'Financially equivalent CSV group; awaiting administrator confirmation',
    ...(candidate.kind === 'log' ? { log_source: candidate.logSource } : { error_id: candidate.errorId, event_index: candidate.eventIndex }) };
}

// Quote every possible pairing. The stable allocation is bookkeeping only; an
// exact request link must never be invented to get past the per-request API.
async function previewGroups(service, batch, body, freshMatches, accessToken, { verifiedTokens, matchProof, report = () => {} }) {
  const groups = new Set(body.rowIds.map(id => service.store.get(id).match?.candidateGroup).filter(group => group?.auditEligible).map(group => group.id));
  const handled = new Set(), results = [];
  if (!groups.size) return { handled, results };
  const rows = service.store.rows(batch.id);
  const total = rows.filter(row => groups.has(row.match?.candidateGroup?.id)).length +
    body.rowIds.filter(id => !groups.has(service.store.get(id).match?.candidateGroup?.id)).length;
  for (const identity of groups) {
    const members = rows.filter(row => row.match?.candidateGroup?.id === identity);
    members.forEach(row => handled.add(row.id));
    if (members.some(started)) { results.push(...members.map(row => ({ rowId: row.id, status: row.status }))); continue; }
    try {
      if (body.pricingMode === 'manual' || Object.values(body.pricing).some(rule => rule.input != null || rule.output != null)) throw conflict('整组核查使用主站自动报价，人工售价请按逐笔证据核查');
      const group = members[0].match.candidateGroup;
      if (members.length !== group.rows || members.length < 2 || members.length > 20) throw conflict('整组成员不完整，请重新分析');
      const previews = [];
      for (const row of members) {
        report({ phase: 'quoting', rowNumber: row.number, completed: results.length, total });
        service.checkMatchVersion(row);
        const fresh = freshMatches.get(row.number);
        if (fresh?.status !== 'group_candidate' || !fresh.candidateGroup?.auditEligible || matchProof(fresh) !== matchProof(row.match)) throw conflict('整组来源或计费证据已变化，请重新分析');
        const tokens = verifiedTokens(row.record, body, body.pricing[row.record.model]);
        const allocation = group.allocations.find(item => item.identity === row.record.identity);
        if (!allocation) throw conflict('整组缺少稳定账单身份');
        let signature, allocated;
        for (const candidate of fresh.candidates) {
          const source = nativeSource(row, candidate);
          let quote;
          try { quote = await service.recovery.request('/imports/quote', { method: 'POST', body: { source, tokens } }, accessToken); }
          catch (error) { throw conflict(`整组主站核查未通过：${error.message}`); }
          const usage = quote?.usage_record;
          if (quote?.group_audit_blocked) throw conflict(quote.group_audit_blocked);
          if (!usage || quote.pricing_source !== 'current_sub2api_prices' || !(usage.ActualCost > 0) ||
            String(usage.UserID) !== candidate.userId || String(usage.APIKeyID) !== candidate.apiKeyId ||
            String(usage.AccountID) !== candidate.accountId || String(usage.GroupID) !== candidate.groupId || usage.SubscriptionID) throw conflict('整组报价身份、计费类型或价格来源不一致');
          const current = quoteSignature(usage);
          if (signature && signature !== current) throw conflict('不同候选对应的主站费用或计费维度不一致，不能整组补记');
          signature = current;
          if (candidate.reference === allocation.reference) allocated = { candidate, source, quote };
        }
        if (!allocated) throw conflict('整组分配不在有效候选中');
        const { candidate, source, quote } = allocated;
        const evidence = JSON.stringify({ source: 'operator_confirmed_supplier_csv_group', group_identity: identity,
          bill_identity: row.record.identity, file_hash: batch.content_hash, row: row.number, supplier_cost: row.record.cost || null,
          allocation: 'financial_equivalence_only', local_reference: candidate.reference, pricing_source: quote.pricing_source,
          pricing_at: quote.pricing_at, tokens_confirmed_final: false });
        const reservation = { ...source, evidence, payload_digest: hash([identity, source, tokens, quote.usage_record]) };
        previews.push({ row, preview: { id: crypto.randomUUID(), reference: candidate.reference, userId: candidate.userId,
          userEmail: candidate.userEmail, apiKeyId: candidate.apiKeyId, billingType: candidate.billingType,
          usage: quote.usage_record, pricingSource: quote.pricing_source, pricingAt: quote.pricing_at,
          reservation, matchProof: matchProof(fresh), expiresAt: service.now() + 3600000 } });
      }
      const payload = previews.slice().sort((a, b) => a.row.record.identity.localeCompare(b.row.record.identity))
        .map(({ preview }) => ({ source: preview.reservation, usage_record: preview.usage }));
      const groupPreview = { identity, memberIds: members.map(row => row.id), count: members.length,
        total: previews.reduce((sum, item) => sum.plus(item.preview.usage.ActualCost), new Decimal(0)).toFixed(8),
        payloadDigest: hash(payload) };
      service.store.db.transaction(() => {
        for (const { row, preview } of previews) service.store.save(row.id, { preview: { ...preview, group: groupPreview },
          selection: preview.reference, selection_confirmed: 1, status: 'preview', result: null }, row.version);
      })();
      results.push(...members.map(row => ({ rowId: row.id, status: 'preview' })));
    } catch (error) {
      if (error.code === 'PREVIEW_CONFLICT') throw error;
      if (!(error instanceof AppError)) throw error;
      service.store.db.transaction(() => {
        for (const row of members) service.store.save(row.id, { preview: null, selection: null, status: 'needs_review', result: { error: error.message } }, row.version);
      })();
      results.push(...members.map(row => ({ rowId: row.id, status: 'needs_review', error: error.message })));
    }
    report({ completed: results.length, total });
  }
  return { handled, results };
}

async function confirmGroups(service, batch, body, accessToken, matchProof, report = () => {}) {
  const selected = new Map(body.rows.map(row => [row.id, row]));
  if (selected.size !== body.rows.length) throw conflict('确认列表存在重复记录');
  const groups = new Set(body.rows.map(row => service.store.get(row.id).preview?.group?.identity).filter(Boolean));
  const handled = new Set(), results = [];
  let freshMatches;
  for (const identity of groups) {
    report({ phase: 'rechecking', completed: results.length, total: body.rows.length });
    const seed = body.rows.map(row => service.store.get(row.id)).find(row => row.preview?.group?.identity === identity);
    const group = seed.preview.group, members = group.memberIds.map(id => service.store.get(id));
    if (members.length !== group.count || members.some(row => row.batch_id !== batch.id || row.preview?.group?.identity !== identity ||
      hash(row.preview.group) !== hash(group) || !selected.has(row.id) || selected.get(row.id).previewId !== row.preview.id)) throw conflict('整组须完整展示并确认，不能只确认部分成员');
    members.forEach(row => handled.add(row.id));
    const payload = members.slice().sort((a, b) => a.record.identity.localeCompare(b.record.identity))
      .map(row => ({ source: row.preview.reservation, usage_record: row.preview.usage }));
    if (hash(payload) !== group.payloadDigest) throw conflict('整组冻结预览已变化');
    if (!members.every(row => row.case_id)) {
      if (!members.some(started) && members.some(row => row.preview.expiresAt < service.now())) throw conflict('整组预览已过期，请重新生成');
      freshMatches ||= await service.recheck(batch, accessToken);
      if (members.some(row => {
        const fresh = freshMatches.get(row.number), claim = fresh?.importClaim;
        const recovered = claim && claim.local_reference === row.preview.reference && String(claim.user_id) === row.preview.userId &&
          String(claim.api_key_id) === row.preview.apiKeyId && Number(claim.account_id) === row.preview.reservation.account_id;
        return !recovered && matchProof(fresh || {}) !== row.preview.matchProof;
      })) throw conflict('整组证据或账单已变化，请重新分析');
    }
    const pending = service.store.db.transaction(() => members.map(row => row.status === 'settled' ? row :
      service.store.claim(row.id, selected.get(row.id).version, row.preview.id)))();
    if (pending.every(row => row.status === 'settled')) {
      results.push(...pending.map(row => ({ id: row.id, status: 'settled', caseId: row.case_id }))); continue;
    }
    try {
      const response = await service.recovery.request('/imports/reserve-group', { method: 'POST', body: {
        identity, payload_digest: group.payloadDigest, members: payload.map(member => ({ ...member,
          source: { ...member.source, evidence: JSON.stringify({ ...JSON.parse(member.source.evidence),
            tokens_confirmed_final: true, ownership_confirmed: true, pricing_confirmed: true }) } })) } }, accessToken);
      const claims = new Map((response.claims || []).map(claim => [claim.bill_identity, claim]));
      if (claims.size !== members.length || new Set([...claims.values()].map(claim => claim.case_id)).size !== members.length || pending.some(row => {
        const claim = claims.get(row.record.identity);
        return !claim?.case_id || claim.local_reference !== row.preview.reference || String(claim.user_id) !== row.preview.userId ||
          String(claim.api_key_id) !== row.preview.apiKeyId || Number(claim.account_id) !== row.preview.reservation.account_id;
      })) throw conflict('主站整组认领回执不完整或归属不一致，已停止结算');
      const reserved = service.store.db.transaction(() => pending.map(row => row.status === 'settled' ? row :
        service.store.save(row.id, { case_id: claims.get(row.record.identity).case_id }, row.version)))();
      for (const row of reserved) {
        report({ phase: 'settling', rowNumber: row.number, completed: results.length });
        results.push(row.status === 'settled' ? { id: row.id, status: 'settled', caseId: row.case_id }
          : await service.settlePreview(row, accessToken, row.case_id));
        report({ completed: results.length });
      }
    } catch (error) {
      service.store.db.transaction(() => {
        for (const member of pending) {
          const row = service.store.get(member.id);
          if (row.status === 'settled') continue;
          service.store.save(row.id, { status: 'failed', lease_until: 0, result: { error: error.message } }, row.version);
          results.push({ id: row.id, status: 'failed', error: error.message });
        }
      })();
    }
  }
  return { handled, results };
}

module.exports = { previewGroups, confirmGroups, quoteSignature };
