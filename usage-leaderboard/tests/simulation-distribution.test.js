'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DEFAULT_RULES, generateSnapshot, generateSimulation, validateCandidate } = require('../src/simulation');

const options = { now: new Date('2026-10-19T03:00:00Z'), timezone: 'Asia/Shanghai', seed: '0123456789abcdef0123456789abcdef' };
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('seeded distributions have irregular gaps, distinct concentration and broad daily usage even with a high floor', () => {
  for (const minimum of [1370000, 137000000]) {
    const gapVariation = { natural: [], close: [], concentrated: [] };
    for (let index = 0; index < 48; index++) {
      const seed = crypto.createHash('sha256').update(String(index)).digest('hex').slice(0, 32);
      for (const distribution of Object.keys(gapVariation)) {
        const rules = { ...DEFAULT_RULES, minimumTokens: minimum, boardMinimumTokens: minimum, distribution };
        const candidate = generateSimulation(rules, { ...options, seed });
        assert.equal(candidate.origin.origin.distributionVersion, 2);
        assert.deepEqual(validateCandidate(candidate, options.timezone), candidate);
        const span = rules.maximumTokens - minimum;
        for (const period of ['today', 'week', 'month', 'all']) {
          const values = candidate.rows.map((row) => row.values[period].tokens).sort((a, b) => b - a);
          assert.ok(values.every((value) => Number.isSafeInteger(value) && value >= minimum && value <= rules.maximumTokens));
          assert.equal(new Set(values.map((value) => (value / 1e6).toFixed(2))).size, 10);
          if (!['today', 'all'].includes(period)) continue;
          const gaps = values.slice(1).map((value, i) => values[i] - value);
          const spread = (values[0] - values.at(-1)) / span;
          if (distribution === 'natural') {
            assert.ok(spread > (period === 'today' ? .12 : .65));
          } else if (distribution === 'concentrated') {
            assert.ok(Math.max(...gaps) / span > (period === 'today' ? .2 : .4));
            assert.ok(gaps.indexOf(Math.max(...gaps)) < 2, 'The major gap must follow one or two leaders');
          } else {
            assert.ok(spread < .25, 'Close mode must retain a compact spread');
          }
          if (period === 'all') {
            const mean = (values[0] - values.at(-1)) / gaps.length;
            gapVariation[distribution].push(Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length) / mean);
          }
        }
      }
    }
    for (const [distribution, values] of Object.entries(gapVariation)) {
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      assert.ok(average > (distribution === 'concentrated' ? 1.3 : .6), `${distribution} gaps must vary across seeds`);
    }
  }
});

test('pre-upgrade snapshots and live timelines replay unchanged while new rosters use the improved distribution', () => {
  const legacyOptions = { ...options, now: new Date('2026-10-15T03:00:00Z') };
  const origin = { generatedAt: legacyOptions.now.toISOString(), rules: DEFAULT_RULES };
  const snapshot = generateSnapshot(DEFAULT_RULES, { ...legacyOptions, origin });
  const { origin: _origin, ...base } = snapshot;
  const { boardMinimumTokens: _minimum, boardMaximumTokens: _maximum, ...rules } = snapshot.rules;
  const live = generateSimulation(DEFAULT_RULES, { ...legacyOptions, origin: snapshot });
  const renewed = generateSimulation(DEFAULT_RULES, { ...legacyOptions, previous: live, now: new Date('2027-01-01T00:00:00Z') });
  const fixtures = [
    [{ ...base, version: 1, rules }, '631de8e17de775f25493d691e81cdc3db7c8d44bb3f626388259cbe1fa99c1b7'],
    [{ ...base, version: 2 }, 'a6aec84f423b545202316b5e4887dbadbb36e013e3bc3037f1e93256533a9eff'],
    [snapshot, 'e689fd02f259e102d7f5ab9dc9e9c7733e924e314caa8d5dde08efab472dc749'],
    [live, '76b976800a9f92fe54ea09b82db8c19e72f941146350973e175d060f5e59aa25'],
    [renewed, '0c88448db7f06ea218aa0c8108da92520131ea0ac7bf7b9360e77d9f229fdc70']
  ];
  for (const [candidate, expected] of fixtures) {
    assert.equal(hash(candidate), expected);
    assert.deepEqual(validateCandidate(candidate, options.timezone), candidate);
  }
  assert.equal(renewed.origin.origin.distributionVersion, undefined);
  const improved = generateSimulation(DEFAULT_RULES, legacyOptions);
  assert.equal(improved.origin.origin.distributionVersion, 2);
  assert.notDeepEqual(improved.rows.map((row) => row.values), live.rows.map((row) => row.values));
  assert.deepEqual(generateSimulation(DEFAULT_RULES, { ...legacyOptions, previous: improved }), improved);
  for (const version of [undefined, 3]) {
    const tampered = structuredClone(improved);
    if (version === undefined) delete tampered.origin.origin.distributionVersion;
    else tampered.origin.origin.distributionVersion = version;
    assert.throws(() => validateCandidate(tampered, options.timezone), { code: 'SIMULATION_INVALID' });
  }
});
