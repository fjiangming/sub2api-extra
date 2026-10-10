'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { money,costCap,enforceMargin } = require('../src/money');
const { resolveSellingPrice } = require('../src/pricing');
const { loadConfig,parseCatalog } = require('../src/config');
const { demoCatalog } = require('../src/demo');
const { parseCoreJson } = require('../src/core-json');

const config = loadConfig({},true);
const request = { model:'custom-video',duration:30,resolution:'720p' };
const group = { rate_multiplier:'1',video_rate_independent:false,video_model_prices:{ 'custom-video':{ '720p':'0.2' } } };
const card = { mode:'per_second',currency:'CNY',prices:{ '720p':'0.87' },usdPerUnit:'0.15',feeMultiplier:'1',fixedFee:'0',
  verifiedAt:'2026-10-09T00:00:00Z',expiresAt:'2026-10-11T00:00:00Z' };

test('decimal accounting rounds upward at the actual eight-decimal balance precision',() => {
  assert.equal(money('0.000000001'),'0.00000001');
  assert.equal(money('0.1'),'0.10000000');
  for (const value of ['NaN','Infinity','-1',undefined]) assert.throws(() => money(value));
});
test('native JSON decimal amounts and large IDs are retained without binary-float conversion',() => {
  const parsed = parseCoreJson('{"id":9007199254740993,"quota":999999999999.12345678,"video_model_prices":{"model":{"720p":0.123456789012}},"min_tokens":0}');
  assert.equal(parsed.id,'9007199254740993');
  assert.equal(parsed.quota,'999999999999.12345678');
  assert.equal(parsed.video_model_prices.model['720p'],'0.123456789012');
  assert.equal(parsed.min_tokens,0);
});
test('CNY rate conversion, full 30-second duration and cost buffer are counted',() => {
  const quote = costCap(card,request,config,new Date('2026-10-10T00:00:00Z'));
  assert.equal(quote.quotedAmountBound,'26.10000000');
  assert.equal(quote.capUsd,'4.30650000');
  assert.equal(resolveSellingPrice(group,null,[],request,config).saleUsd,'6.00000000');
});
test('expired, future-verified and missing supplier cost tiers are rejected',() => {
  assert.throws(() => costCap(card,request,config,new Date('2026-10-12T00:00:00Z')), { code:'COST_CARD_EXPIRED' });
  assert.throws(() => costCap(card,request,config,new Date('2026-10-08T00:00:00Z')), { code:'COST_CARD_UNVERIFIED' });
  assert.throws(() => costCap(card,{ ...request,resolution:'1080p' },config,new Date('2026-10-10T00:00:00Z')), { code:'COST_TIER_MISSING' });
});
test('supplier per-item price is not multiplied by duration',() => {
  const result = costCap({ ...card,mode:'per_request',prices:{ default:'2.1' } },request,config,new Date('2026-10-10T00:00:00Z'));
  assert.equal(result.quotedAmountBound,'2.10000000');
});
test('recharge discounts, fees and minimum margin prevent nominal-price losses',() => {
  assert.throws(() => enforceMargin('1','0.9',config), { code:'UNPROFITABLE_PRICE' });
  assert.throws(() => enforceMargin('100','21',config), { code:'JOB_COST_LIMIT' });
  assert.ok(enforceMargin('2','0.9',config));
});
test('group profit controls can tighten the global margin',() => {
  assert.ok(enforceMargin('2','1',config));
  assert.throws(() => enforceMargin('2','1',config,{ profit_control_enabled:true,profit_min_margin:'0.5',profit_safety_buffer:'0.05' }), { code:'UNPROFITABLE_PRICE' });
});
test('group video model cards outrank family and channel rates',() => {
  const value = resolveSellingPrice({ ...group,model_pricing:[{ models:['custom-video'],billing_mode:'video',per_request_price:'0.4' }] },null,[{ models:['custom-video'],billing_mode:'per_request',per_request_price:'99' }],request,config);
  assert.equal(value.source,'group.model_pricing');
  assert.equal(value.saleUsd,'12.00000000');
});
test('family and legacy video prices outrank per-request channel prices',() => {
  const channels = [{ models:['custom-video'],billing_mode:'per_request',per_request_price:'2' }];
  assert.equal(resolveSellingPrice(group,null,channels,request,config).saleUsd,'6.00000000');
  assert.equal(resolveSellingPrice({ ...group,video_model_prices:{},video_price_720p:'0.3' },null,channels,request,config).saleUsd,'9.00000000');
});
test('channel per-request prices charge once and video tiers charge per second',() => {
  const bare = { rate_multiplier:'1' };
  assert.equal(resolveSellingPrice(bare,null,[{ models:['custom-video'],billing_mode:'per_request',per_request_price:'2' }],request,config).saleUsd,'2.00000000');
  assert.equal(resolveSellingPrice(bare,null,[{ models:['custom-video'],billing_mode:'video',intervals:[{ tier_label:'720p',per_request_price:'0.2' }] }],request,config).saleUsd,'6.00000000');
});
test('user-specific rates replace group rates and independent video rates replace both',() => {
  assert.equal(resolveSellingPrice({ ...group,rate_multiplier:'2' },'0.5',[],request,config).saleUsd,'3.00000000');
  assert.equal(resolveSellingPrice({ ...group,video_rate_independent:true,video_rate_multiplier:'1.5' },'0.5',[],request,config).saleUsd,'9.00000000');
});
test('peak multiplier is applied using the configured station timezone',() => {
  const peak = { ...group,peak_rate_enabled:true,peak_start:'09:00',peak_end:'11:00',peak_rate_multiplier:'2' };
  assert.equal(resolveSellingPrice(peak,null,[],request,config,new Date('2026-10-10T02:00:00Z')).saleUsd,'12.00000000');
});
test('missing, zero and token prices never fall back to native xAI pricing',() => {
  assert.throws(() => resolveSellingPrice({ rate_multiplier:'1' },null,[],request,config), { code:'SELL_PRICE_MISSING' });
  assert.throws(() => resolveSellingPrice({ ...group,video_rate_independent:true,video_rate_multiplier:'0' },null,[],request,config), { code:'FREE_VIDEO_DENIED' });
  assert.throws(() => resolveSellingPrice({ rate_multiplier:'1' },null,[{ models:['custom-video'],billing_mode:'token' }],request,config), { code:'BILLING_MODE_UNSUPPORTED' });
});
test('catalog rejects typos, duplicate aliases and mock providers in production',() => {
  const input = demoCatalog();
  assert.throws(() => parseCatalog({ ...input,unexpected:true },{},false));
  assert.throws(() => parseCatalog({ ...input,models:[input.models[0],input.models[0]] },{},false));
  assert.throws(() => parseCatalog(input,{},true));
});

test('automatic refunds require a verified contract for extra fees',() => {
  const input = demoCatalog();
  const { apiKey,...provider } = input.providers[0];
  const model = { ...input.models[0],cost:{ ...input.models[0].cost,fixedFee:'0.02' } };
  const catalog = { ...input,providers:[provider],models:[model] };
  assert.throws(() => parseCatalog(catalog,{},false),{ code:'INVALID_CATALOG' });
  catalog.models[0].cost.feesRefundable = true;
  assert.ok(parseCatalog(catalog,{},false));
});

test('enabling upstream idempotency requires a verified retention duration',() => {
  const input = demoCatalog();
  const { apiKey,idempotencyRetentionSeconds,...provider } = input.providers[0];
  const catalog = { ...input,providers:[provider] };
  assert.throws(() => parseCatalog(catalog,{},false),{ code:'INVALID_CATALOG' });
  catalog.providers[0].idempotencyRetentionSeconds = 60;
  assert.ok(parseCatalog(catalog,{},false));
});
