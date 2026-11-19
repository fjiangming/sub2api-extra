'use strict';

const {z} = require('zod');
const {AppError} = require('../errors');
const {ConversationPushStore,filterSchema} = require('../conversation-push-store');
const {processingBudgets} = require('./conversation-memory');
const {deliveryBodyFromRaw} = require('./conversation-envelope');

const exportSchema = z.object({filter:filterSchema.default({}),source:z.enum(['masked','original']).default('masked'),
  limit:z.number().int().min(1).max(10000).default(1000)}).strict();
const fields = 'id,request_id,user_id,model,at,bytes,archived_at,policy_version,processed_at,processing_pending,processing_policy_version,processing_error,complete,reason,redaction_version,redaction_policy_hash,inspection_warnings,original,masked,body_sha256';
const failure = (code,message,status=409) => new AppError('CONVERSATION_EXPORT_'+code,message,{status});
function parseExport(input) {
  const result = exportSchema.safeParse(input);
  if (!result.success) throw failure('INVALID_INPUT','导出参数无效：最近条数须为 1 至 10,000 的整数',400);
  return result.data;
}

class ConversationExportData {
  constructor(archive,{memoryBudgetBytes}={}) {
    this.archive=archive;this.memoryBudgetBytes=memoryBudgetBytes;this.copies=new ConversationPushStore(archive);
  }
  select(input) {
    const spec=parseExport(input);
    return this.archive.db.transaction(() => {
      if (!this.archive.metadataStatus().ready) throw failure('HISTORY_PREPARING','历史索引仍在准备，请稍后导出');
      const policy=this.archive.policy(),where=this.archive.where(spec.filter,true);
      const rows=this.archive.db.prepare(`SELECT rowid AS revision,${fields} FROM cl_record_metadata${where.sql} ORDER BY at DESC,id LIMIT ?`).all(...where.args,spec.limit);
      const skipped={},eligible=[];
      for (const row of rows) {
        const reason=!this.copies.allowed(row,policy) ? 'COLLECTION_EXCLUDED'
          : this.copies.blockedReason(row,spec.source,policy,{captureScope:'all'});
        if (reason) skipped[reason]=(skipped[reason] || 0)+1;
        else eligible.push(row);
      }
      return {spec,policyVersion:policy.version,selected:rows.length,skipped,rows:eligible};
    })();
  }
  guard(selection,row) {
    const policy=this.archive.db.prepare('SELECT version FROM cl_policies ORDER BY version DESC LIMIT 1').get();
    if (policy?.version!==selection.policyVersion) throw failure('POLICY_CHANGED','保存规则已变更，本次下载已中止，请按新规则重新导出');
    if (row) {
      const current=this.archive.db.prepare(`SELECT rowid AS revision,${fields} FROM cl_record_metadata WHERE id=?`).get(row.id);
      if (!current || JSON.stringify(current)!==JSON.stringify(row)) throw failure('RECORD_CHANGED','所选日志已删除或重新处理，本次下载已中止，请重新导出');
    }
  }
  envelope(selection,row,format) {
    return this.archive.db.transaction(() => {
      this.guard(selection,row);
      const copy=this.copies.copySelection(row,selection.spec.source,this.archive.policy());
      const sizes=this.archive.db.prepare('SELECT length(original) AS original,length(masked) AS masked FROM cl_records WHERE id=?').get(row.id);
      // One copy is opened at a time; reserve for a possible masked-read fallback, never sum both stored copies.
      const copyBytes=copy.source==='masked' ? Math.max(sizes.masked || 0,sizes.original || 0) : sizes[copy.source] || 0;
      const budget=processingBudgets(this.memoryBudgetBytes);
      // Ciphertext and decoded Buffers consume process memory, not V8 old-space. Protect both budgets separately.
      if (copyBytes*8+1048576>budget.memory || copyBytes*4+1048576>budget.heap) {
        throw failure('MEMORY',`单条日志处理内存不足（请求 ID：${row.request_id}，副本约 ${(copyBytes/1024**2).toFixed(1)} MiB），已中止下载且未截断归档；请稍后重试，减少条数不一定有效`);
      }
      return this.copies.envelope({id:row.id,record_id:row.id,source:selection.spec.source},undefined,{format});
    })();
  }
  record(selection,row) {
    const envelope=this.envelope(selection,row,(raw,options)=>({body:deliveryBodyFromRaw(raw,options)}));
    return {body:envelope.body,fallbackReason:envelope.fallback_reason};
  }
}

module.exports={ConversationExportData,parseExport,failure};
