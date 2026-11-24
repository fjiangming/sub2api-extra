'use strict';

const { randomInt } = require('node:crypto');

// Private server configuration. Never include weights or eligibility in public responses.
const PRIZES = Object.freeze([
  { amount: 50, weight: 5200, minimum: 0 }, { amount: 100, weight: 2000, minimum: 0 },
  { amount: 200, weight: 1000, minimum: 0 }, { amount: 300, weight: 500, minimum: 0 },
  { amount: 500, weight: 200, minimum: 0 }, { amount: 1000, weight: 500, minimum: 100000 },
  { amount: 2000, weight: 400, minimum: 200000 }, { amount: 5000, weight: 200, minimum: 500000 }
].map(Object.freeze));
const COMPENSATION_DEFAULT_WEIGHTS = Object.freeze([
  { amount: 50, weight: 6000 }, { amount: 100, weight: 2000 }, { amount: 200, weight: 1000 }, { amount: 300, weight: 500 },
  { amount: 500, weight: 300 }, { amount: 1000, weight: 100 }, { amount: 2000, weight: 70 }, { amount: 5000, weight: 30 }
].map(Object.freeze));

function sampleWeights(weights, rng = randomInt) {
  const roll = rng(10000);
  if (!Number.isInteger(roll) || roll < 0 || roll >= 10000) throw new Error('Invalid random sample');
  let cumulative = 0;
  for (const prize of weights) {
    cumulative += prize.weight;
    if (roll < cumulative) return prize.amount;
  }
  throw new Error('Invalid prize distribution');
}

function sample(rechargeMinor, rng = randomInt, prizes = PRIZES) {
  const roll = rng(10000);
  if (!Number.isInteger(roll) || roll < 0 || roll >= 10000) throw new Error('Invalid random sample');
  const missing = prizes.filter(p => p.minimum > rechargeMinor).reduce((sum, p) => sum + p.weight, 0);
  const weights = prizes.map((prize, index) => ({ amount: prize.amount, weight: index === 0 ? prize.weight + missing : prize.minimum <= rechargeMinor ? prize.weight : 0 }));
  let cumulative = 0;
  for (const prize of weights) {
    cumulative += prize.weight;
    if (roll < cumulative) return prize.amount;
  }
  throw new Error('Invalid prize distribution');
}

module.exports = { PRIZES, COMPENSATION_DEFAULT_WEIGHTS, sample, sampleWeights };
