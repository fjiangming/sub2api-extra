'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const { AppError } = require('../errors');

const secret = z.string().max(4096).regex(/^[^\r\n]*$/).optional();
const policySchema = z.object({
  version: z.number().int().positive(), enabled: z.boolean(), automatic: z.boolean(), source: z.enum(['masked','original']),
  allowPrivateNetwork: z.boolean(), maxAttempts: z.number().int().min(1).max(10),
  retrySeconds: z.number().int().min(5).max(3600), timeoutSeconds: z.number().int().min(3).max(60),
  queueLimit: z.number().int().min(100).max(50000),
  webhook: z.object({enabled:z.boolean(),url:z.string().trim().max(2048),token:secret,clearToken:z.boolean().optional()}).strict(),
  s3: z.object({enabled:z.boolean(),endpoint:z.string().trim().max(2048),region:z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/),
    bucket:z.string().trim().max(63),prefix:z.string().trim().max(180).regex(/^[A-Za-z0-9._/-]*$/),forcePathStyle:z.boolean(),
    accessKeyId:secret,secretAccessKey:secret,sessionToken:secret,clearCredentials:z.boolean().optional(),clearSessionToken:z.boolean().optional()}).strict()
}).strict();
const defaults = {version:1,enabled:false,automatic:false,source:'masked',allowPrivateNetwork:false,maxAttempts:5,retrySeconds:30,timeoutSeconds:15,queueLimit:10000,
  webhook:{enabled:false,url:'',token:''},s3:{enabled:false,endpoint:'',region:'us-east-1',bucket:'',prefix:'conversation-logs',forcePathStyle:true,accessKeyId:'',secretAccessKey:'',sessionToken:''}};
function invalid(message = '推送策略参数无效', code = 'CONVERSATION_PUSH_INVALID', status = 400) { return new AppError(code,message,{status}); }
function endpoint(value, allowPrivateNetwork, kind) {
  let url; try { url = new URL(value); } catch { throw invalid('请输入完整的推送目标 URL'); }
  if (!['https:','http:'].includes(url.protocol) || url.protocol === 'http:' && !allowPrivateNetwork || url.username || url.password || url.hash || url.search) throw invalid('目标须使用 HTTPS；私有网络可显式允许 HTTP。鉴权请使用凭据字段');
  if (kind === 's3' && url.pathname !== '/') throw invalid('S3 Endpoint 不包含 Bucket 或对象路径');
  return url.href;
}
function parsePolicy(input, current) {
  const parsed = policySchema.safeParse(input); if (!parsed.success) throw invalid();
  const value = parsed.data;
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
  if (value.enabled && !value.webhook.enabled && !value.s3.enabled) throw invalid('请至少启用一个推送目标');
  value.version++;
  return value;
}
function publicPolicy(value) {
  return {...value,webhook:{enabled:value.webhook.enabled,url:value.webhook.url,tokenConfigured:Boolean(value.webhook.token)},
    s3:{enabled:value.s3.enabled,endpoint:value.s3.endpoint,region:value.s3.region,bucket:value.s3.bucket,prefix:value.s3.prefix,forcePathStyle:value.s3.forcePathStyle,
      credentialsConfigured:Boolean(value.s3.accessKeyId && value.s3.secretAccessKey),sessionTokenConfigured:Boolean(value.s3.sessionToken)}};
}
function targetHash(policy, destination) {
  const target = policy[destination];
  const identity = destination === 'webhook' ? {url:target.url} : {endpoint:target.endpoint,region:target.region,bucket:target.bucket,prefix:target.prefix,forcePathStyle:target.forcePathStyle};
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
module.exports = {defaults,policySchema,parsePolicy,publicPolicy,targetHash,invalid};
