'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const ipaddr = require('ipaddr.js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { deliveryBody } = require('./conversation-envelope');
const transportFailure = Symbol('conversation-push-failure');

function failure(code, retryable = false, httpStatus = 0) {
  return Object.assign(new Error(code), { [transportFailure]:true, pushCode:code, retryable, httpStatus });
}
function failureResult(error) {
  const trusted = error[transportFailure], status = trusted ? error.httpStatus : error.$metadata?.httpStatusCode;
  const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  return {status:'failed',errorCode:trusted ? error.pushCode : code >= 300 && code < 400 ? 'REDIRECT_REJECTED' : code ? 'HTTP_REJECTED' : 'NETWORK_FAILED',
    httpStatus:code,retryable:trusted ? error.retryable : !code || code===408 || code===429 || code>=500};
}
function checkAddress(address, allowPrivate) {
  let ip; try { ip=ipaddr.process(address); } catch { throw failure('ADDRESS_BLOCKED'); }
  const range=ip.range();
  if (['100.100.100.200','168.63.129.16','fd00:ec2::254','fd20:ce::254'].includes(ip.toString())) throw failure('ADDRESS_BLOCKED');
  if (range==='unicast' || allowPrivate && ['private','loopback','uniqueLocal','carrierGradeNat'].includes(range)) return;
  throw failure('ADDRESS_BLOCKED');
}
function abortable(operation, signal) {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(failure('ABORTED',true));
    if(signal.aborted)return abort();
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(operation).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
class ConversationPushTransport {
  constructor({lookup=dns.lookup}={}) { this.lookup=lookup; }
  sendJsonl(policy,file,envelopes,signal,hooks) { return require('./conversation-jsonl-transport').sendJsonl(this,policy,file,envelopes,signal,hooks); }
  abortJsonl(policy,file) { return require('./conversation-jsonl-transport').abortJsonl(this,policy,file); }
  async resolve(host,allowPrivate,signal) {
    host=host.replace(/^\[|\]$/g,'');
    let addresses;
    if(ipaddr.isValid(host))addresses=[{address:host,family:ipaddr.parse(host).kind()==='ipv6'?6:4}];
    else try { addresses=await abortable(this.lookup(host,{all:true,verbatim:true}),signal); }
    catch(error) { if(error[transportFailure])throw error;throw failure('DNS_FAILED',true); }
    if(!addresses.length)throw failure('DNS_FAILED',true);
    for(const item of addresses)checkAddress(item.address,allowPrivate);
    return addresses[0];
  }
  async send(policy,destination,envelope,outerSignal,{guard=()=>{}}={}) {
    const controller=new AbortController(),abort=()=>controller.abort();
    outerSignal?.addEventListener('abort',abort,{once:true});
    if(outerSignal?.aborted)controller.abort();
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},policy.timeoutSeconds*1000);
    const pinned=new Map(),agents=[];
    let client,httpStatus=0;
    const validate=async host=>{
      const address=await this.resolve(host,policy.allowPrivateNetwork,controller.signal);
      guard();
      if(controller.signal.aborted)throw failure('ABORTED',true);
      pinned.set(host.replace(/^\[|\]$/g,''),address);
    };
    const lookup=(host,options,callback)=>{
      const address=pinned.get(host.replace(/^\[|\]$/g,''));
      if(!address)return callback(failure('ADDRESS_BLOCKED'));
      callback(null,options?.all?[address]:address.address,address.family);
    };
    const httpAgent=new http.Agent({keepAlive:false,maxSockets:1,lookup});
    const httpsAgent=new https.Agent({keepAlive:false,maxSockets:1,lookup});
    agents.push(httpAgent,httpsAgent);
    try {
      const target=policy[destination],url=new URL(destination==='s3'?target.endpoint:target.url);
      if(url.protocol!=='https:' && !(url.protocol==='http:' && policy.allowPrivateNetwork))throw failure('ADDRESS_BLOCKED');
      const body=Buffer.from(JSON.stringify(deliveryBody(envelope)));
      guard();
      if(destination==='webhook') {
        await validate(url.hostname);
        await new Promise((resolve,reject)=>{
          const headers={'content-type':'application/json','content-length':body.length,'idempotency-key':envelope.delivery_id};
          if(target.token)headers.authorization='Bearer '+target.token;
          const request=(url.protocol==='https:'?https:http).request(url,{method:'POST',headers,agent:url.protocol==='https:'?httpsAgent:httpAgent,signal:controller.signal},response=>{
            const status=response.statusCode;
            httpStatus=status;
            response.destroy();
            if(status>=200&&status<300)resolve();
            else reject(failure(status>=300&&status<400?'REDIRECT_REJECTED':'HTTP_REJECTED',status===408||status===429||status>=500,status));
          });
          request.on('error',reject);
          request.end(body);
        });
      } else {
        const handler=new NodeHttpHandler({httpAgent,httpsAgent,connectionTimeout:policy.timeoutSeconds*1000,socketTimeout:policy.timeoutSeconds*1000});
        // Error XML is untrusted; the SDK must never buffer an unbounded response.
        const boundedHandler={metadata:handler.metadata,destroy:()=>handler.destroy(),handle:async(request,options)=>{
          const result=await handler.handle(request,options);
          let bytes=0;
          const limit=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;callback(bytes>65536?failure('RESPONSE_TOO_LARGE'):null,chunk);}});
          result.response.body.on('error',error=>limit.destroy(error));
          limit.on('close',()=>result.response.body.destroy());
          return {response:{...result.response,body:result.response.body.pipe(limit)}};
        }};
        client=new S3Client({endpoint:target.endpoint,region:target.region,forcePathStyle:target.forcePathStyle,
          credentials:{accessKeyId:target.accessKeyId,secretAccessKey:target.secretAccessKey,...(target.sessionToken?{sessionToken:target.sessionToken}:{})},
          maxAttempts:1,followRegionRedirects:false,requestHandler:boundedHandler,requestChecksumCalculation:'WHEN_REQUIRED'});
        client.middlewareStack.add(next=>async args=>{
          const host=args.request.hostname.replace(/^\[|\]$/g,'');
          const base=url.hostname.replace(/^\[|\]$/g,'');
          if(host!==base&&host!==`${target.bucket}.${base}`)throw failure('ADDRESS_BLOCKED');
          await validate(host);
          return next(args);
        },{step:'finalizeRequest',name:'validateConversationPushAddress',priority:'low'});
        const date=new Date(envelope.metadata?.at||Date.now()).toISOString().slice(0,10);
        const key=[target.prefix,date,envelope.delivery_id+'.json'].filter(Boolean).join('/');
        const result=await client.send(new PutObjectCommand({Bucket:target.bucket,Key:key,Body:body,ContentType:'application/json',
          Metadata:{'delivery-id':envelope.delivery_id},ChecksumSHA256:crypto.createHash('sha256').update(body).digest('base64')}),{abortSignal:controller.signal});
        httpStatus=result.$metadata.httpStatusCode;
      }
      return {status:'sent',httpStatus};
    } catch(error) {
      if(error.code==='EXPORT_MEMORY')return {status:'failed',errorCode:'EXPORT_MEMORY',retryable:true};
      if(timedOut)return {status:'failed',errorCode:'TIMEOUT',retryable:true};
      if(controller.signal.aborted)return {status:'failed',errorCode:'ABORTED',retryable:true};
      const trusted=error[transportFailure],code=trusted?error.httpStatus:error.$metadata?.httpStatusCode;
      const status=Number.isInteger(code)&&code>=100&&code<=599?code:0;
      return {status:'failed',errorCode:trusted?error.pushCode:(status>=300&&status<400?'REDIRECT_REJECTED':status?'HTTP_REJECTED':'NETWORK_FAILED'),
        httpStatus:status,retryable:trusted?error.retryable:(!status||status===408||status===429||status>=500)};
    } finally {
      clearTimeout(timer);outerSignal?.removeEventListener('abort',abort);
      client?.destroy();for(const agent of agents)agent.destroy();
    }
  }
}
module.exports={ConversationPushTransport,checkAddress,failure,failureResult};
