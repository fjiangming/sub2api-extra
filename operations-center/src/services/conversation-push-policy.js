'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const { AppError } = require('../errors');

const secret = z.string().max(4096).regex(/^[^\r\n]*$/).optional();
const platformIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const defaultStorageRates = [['gpt-6-astra','40000'],['gpt-6.1-sol','40000'],['gpt-6.2-astra','40000'],['gpt-6.2-sol','40000'],
  ['claude-opus-5-5','80000'],['claude-opus-5','50000'],['fable-5','60000'],['fable-5-1','80000'],['fable-5-2','100000']].map(([model,price])=>({model,price}));
const priceSchema = z.preprocess(value=>typeof value==='number'&&Number.isFinite(value)?String(value):value,
  z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,4})?$/)).transform(value=>{
  const [whole,fraction='']=value.split('.'),decimal=fraction.replace(/0+$/,'');return whole+(decimal?'.'+decimal:'');
});
const billingSchema = z.object({enabled:z.boolean(),version:z.number().int().positive().optional(),
  rates:z.array(z.object({model:z.string().trim().min(1).max(160),price:priceSchema}).strict()).max(200)
    .refine(rows=>new Set(rows.map(row=>row.model)).size===rows.length)}).strict();
const billingDefaults = () => ({enabled:false,version:1,rates:defaultStorageRates.map(row=>({...row}))});
const jsonlDefaults = { maxFileBytes: 10000000000, timezone: 'Asia/Shanghai', flushMinutes: 0, uploadMiBPerSecond: 2 };
const jsonlSchema = z.object({
  maxFileBytes: z.number().int().min(1048576).max(10000000000),
  timezone: z.string().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }),
  flushMinutes: z.number().int().min(0).max(1440),
  uploadMiBPerSecond: z.number().min(0.25).max(64).default(2)
}).strict();
const webhookSchema = z.object({enabled:z.boolean(),name:z.string().trim().min(1).max(80).optional(),billing:billingSchema.optional(),
  url:z.string().trim().max(2048),token:secret,clearToken:z.boolean().optional()}).strict();
const s3Schema = z.object({enabled:z.boolean(),name:z.string().trim().min(1).max(80).optional(),billing:billingSchema.optional(),
  endpoint:z.string().trim().max(2048),region:z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/),
  bucket:z.string().trim().max(63),prefix:z.string().trim().max(180).regex(/^[A-Za-z0-9._/-]*$/),forcePathStyle:z.boolean(),
  accessKeyId:secret,secretAccessKey:secret,sessionToken:secret,clearCredentials:z.boolean().optional(),clearSessionToken:z.boolean().optional(),
  format:z.enum(['json','jsonl']).optional(),jsonl:jsonlSchema.optional()}).strict();
const platformSchema = z.discriminatedUnion('type',[
  s3Schema.extend({id:platformIdSchema,type:z.literal('s3')}),
  webhookSchema.extend({id:platformIdSchema,type:z.literal('webhook')})
]);
const policySchema = z.object({
  version: z.number().int().positive(), enabled: z.boolean(), automatic: z.boolean(), source: z.enum(['masked','original']),
  automaticMode: z.enum(['realtime','previous_day']),
  captureScope: z.enum(['complete','all']).default('complete'),
  deleteAfterPush: z.boolean(),
  allowPrivateNetwork: z.boolean(), maxAttempts: z.number().int().min(1).max(10),
  retrySeconds: z.number().int().min(5).max(3600), timeoutSeconds: z.number().int().min(3).max(60),
  queueLimit: z.number().int().min(100).max(50000),
  webhook:webhookSchema,s3:s3Schema,platforms:z.array(platformSchema).max(18).optional()
}).strict();
const defaults = {version:1,enabled:false,automatic:false,automaticMode:'realtime',source:'masked',captureScope:'complete',deleteAfterPush:false,allowPrivateNetwork:false,maxAttempts:5,retrySeconds:30,timeoutSeconds:15,queueLimit:10000,
  webhook:{enabled:false,url:'',token:''},s3:{enabled:false,endpoint:'',region:'us-east-1',bucket:'',prefix:'conversation-logs',forcePathStyle:true,accessKeyId:'',secretAccessKey:'',sessionToken:'',format:'jsonl',jsonl:jsonlDefaults}};
function normalizePolicy(value) {
  return {automaticMode:'realtime',captureScope:'complete',deleteAfterPush:false,...value,
    webhook:{...value.webhook,name:value.webhook.name||'Webhook',billing:value.webhook.billing||billingDefaults()},
    s3:{...value.s3,name:value.s3.name||'S3',billing:value.s3.billing||billingDefaults(),format:value.s3.format || 'json',jsonl:{...jsonlDefaults,...value.s3.jsonl}},
    platforms:(value.platforms||[]).map(target=>({...target,billing:target.billing||billingDefaults(),
      ...(target.type==='s3'?{format:target.format||'jsonl',jsonl:{...jsonlDefaults,...target.jsonl}}:{})}))};
}
function targets(policy) { return [{...policy.webhook,id:'webhook',type:'webhook'},{...policy.s3,id:'s3',type:'s3'},...(policy.platforms||[])]; }
function target(policy,id) { return targets(policy).find(item=>item.id===id); }
function targetPolicy(policy,id) {
  const value=target(policy,id);if(!value)throw invalid('推送平台不存在');
  return {...policy,[value.type]:value};
}
function invalid(message = '推送策略参数无效', code = 'CONVERSATION_PUSH_INVALID', status = 400) { return new AppError(code,message,{status}); }
function endpoint(value, allowPrivateNetwork, kind) {
  let url; try { url = new URL(value); } catch { throw invalid('请输入完整的推送目标 URL'); }
  if (!['https:','http:'].includes(url.protocol) || url.protocol === 'http:' && !allowPrivateNetwork || url.username || url.password || url.hash || url.search) throw invalid('目标须使用 HTTPS；私有网络可显式允许 HTTP。鉴权请使用凭据字段');
  if (kind === 's3' && url.pathname !== '/') throw invalid('S3 Endpoint 不包含 Bucket 或对象路径');
  return url.href;
}
function parsePolicy(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const candidate = {...input,automaticMode:input.automaticMode === undefined ? current.automaticMode ?? 'realtime' : input.automaticMode,
    captureScope:input.captureScope ?? current.captureScope ?? 'complete',deleteAfterPush:input.deleteAfterPush ?? current.deleteAfterPush ?? false};
  if (input.s3?.jsonl) candidate.s3 = {...input.s3,jsonl:{...jsonlDefaults,...current.s3.jsonl,...input.s3.jsonl}};
  const parsed = policySchema.safeParse(candidate); if (!parsed.success) throw invalid();
  const value = parsed.data;
  value.platforms ??= current.platforms || [];
  if(new Set(targets(value).map(item=>item.id)).size!==2+value.platforms.length)throw invalid('推送平台 ID 重复');
  for(const item of targets(value)){
    const before=target(current,item.id);
    if(before && before.type!==item.type)throw invalid('已有平台不能更换协议类型');
    const destination=item.id==='s3'||item.id==='webhook'?value[item.id]:value.platforms.find(row=>row.id===item.id);
    destination.name ||= before?.name || (item.type==='s3'?'S3':'Webhook');
    const billing=destination.billing||before?.billing||billingDefaults(),previous=before?.billing||billingDefaults();
    billing.rates=billing.rates.map(row=>({...row})).sort((a,b)=>a.model<b.model?-1:a.model>b.model?1:0);
    const unchanged=billing.enabled===previous.enabled&&JSON.stringify(billing.rates)===JSON.stringify([...previous.rates].sort((a,b)=>a.model<b.model?-1:a.model>b.model?1:0));
    destination.billing={...billing,version:before?(previous.version+Number(!unchanged)):1};
    if(item.id==='s3'||item.id==='webhook')continue;
    if(item.type==='webhook'){
      destination.token=destination.clearToken?'':destination.token||before?.token||'';delete destination.clearToken;
      if(destination.url)destination.url=endpoint(destination.url,value.allowPrivateNetwork,'webhook');
      if(destination.enabled&&!destination.url)throw invalid('请配置平台接收 URL');
    }else{
      destination.format??=before?.format||'jsonl';destination.jsonl={...jsonlDefaults,...before?.jsonl,...destination.jsonl};
      for(const key of ['accessKeyId','secretAccessKey','sessionToken'])destination[key]=destination.clearCredentials?'':destination[key]||before?.[key]||'';
      if(destination.clearSessionToken)destination.sessionToken='';delete destination.clearCredentials;delete destination.clearSessionToken;
      if(destination.endpoint)destination.endpoint=endpoint(destination.endpoint,value.allowPrivateNetwork,'s3');
      destination.prefix=destination.prefix.replace(/^\/+|\/+$/g,'');
      if(destination.prefix.split('/').some(part=>part==='.'||part==='..'))throw invalid('对象前缀不能包含 . 或 .. 路径段');
      if(destination.enabled&&(!destination.endpoint||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(destination.bucket)||!destination.accessKeyId||!destination.secretAccessKey))throw invalid('请配置平台 Endpoint、Bucket 和访问凭据');
    }
  }
  value.s3.format ??= current.s3.format || 'json';
  value.s3.jsonl ??= {...jsonlDefaults,...current.s3.jsonl};
  if (value.version !== current.version) throw invalid('推送策略已更新，请重新读取','CONVERSATION_PUSH_CONFLICT',409);
  value.webhook.token = value.webhook.clearToken ? '' : value.webhook.token || current.webhook.token || '';
  for (const key of ['accessKeyId','secretAccessKey','sessionToken']) value.s3[key] = value.s3.clearCredentials ? '' : value.s3[key] || current.s3[key] || '';
  if (value.s3.clearSessionToken) value.s3.sessionToken = '';
  delete value.webhook.clearToken; delete value.s3.clearCredentials; delete value.s3.clearSessionToken;
  if (value.webhook.url) value.webhook.url = endpoint(value.webhook.url,value.allowPrivateNetwork,'webhook');
  if (value.s3.endpoint) value.s3.endpoint = endpoint(value.s3.endpoint,value.allowPrivateNetwork,'s3');
  value.s3.prefix = value.s3.prefix.replace(/^\/+|\/+$/g,'');
  if (value.s3.prefix.split('/').some(part => part === '.' || part === '..')) throw invalid('对象前缀不能包含 . 或 .. 路径段');
  if (value.webhook.enabled && !value.webhook.url) throw invalid('请配置 Webhook URL');
  if (value.s3.enabled && (!value.s3.endpoint || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.s3.bucket) || !value.s3.accessKeyId || !value.s3.secretAccessKey)) throw invalid('请配置 S3 Endpoint、Bucket 和访问凭据');
  if (value.enabled && !targets(value).some(item=>item.enabled)) throw invalid('请至少启用一个推送目标');
  value.version++;
  return value;
}
function publicPolicy(value) {
  const sanitized=item=>{
    const {token,accessKeyId,secretAccessKey,sessionToken,...safe}=item;
    return {...safe,...(item.type==='webhook'?{tokenConfigured:Boolean(token)}:{credentialsConfigured:Boolean(accessKeyId&&secretAccessKey),sessionTokenConfigured:Boolean(sessionToken)})};
  };
  return {...value,platforms:(value.platforms||[]).map(sanitized),webhook:{enabled:value.webhook.enabled,name:value.webhook.name,billing:value.webhook.billing,url:value.webhook.url,tokenConfigured:Boolean(value.webhook.token)},
    s3:{enabled:value.s3.enabled,endpoint:value.s3.endpoint,region:value.s3.region,bucket:value.s3.bucket,prefix:value.s3.prefix,forcePathStyle:value.s3.forcePathStyle,
      name:value.s3.name,billing:value.s3.billing,
      credentialsConfigured:Boolean(value.s3.accessKeyId && value.s3.secretAccessKey),sessionTokenConfigured:Boolean(value.s3.sessionToken),format:value.s3.format,jsonl:{...value.s3.jsonl}}};
}
function targetHash(policy, destination) {
  const value = target(policy,destination);if(!value)return '';
  const identity = value.type === 'webhook' ? {url:value.url} : {endpoint:value.endpoint,region:value.region,bucket:value.bucket,prefix:value.prefix,forcePathStyle:value.forcePathStyle};
  if (value.type === 's3' && value.format === 'jsonl') Object.assign(identity,{format:'jsonl',timezone:value.jsonl.timezone});
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
module.exports = {defaults,jsonlDefaults,defaultStorageRates,normalizePolicy,policySchema,parsePolicy,publicPolicy,targetHash,targets,target,targetPolicy,platformIdSchema,invalid};
