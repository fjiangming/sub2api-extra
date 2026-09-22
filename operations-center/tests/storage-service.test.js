'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  StorageService,
  CANDIDATE_TABLES
} = require('../src/services/storage-service');

test('capacity sample treats every non-candidate relation as protected', async () => {
  let parameters = null;
  const pool = {
    async query(sql, params) {
      parameters = params;
      assert.match(sql, /AS candidate_bytes/);
      return {
        rows: [{
          database_bytes: '1000',
          relation_bytes: '800',
          candidate_bytes: '500'
        }]
      };
    }
  };
  const service = new StorageService(pool, {}, {
    cacheTtlSeconds: 0,
    capacitySampleLimit: 24,
    capacitySampleIntervalMinutes: 30
  });

  const sample = await service.captureSample();
  assert.deepEqual(parameters, [CANDIDATE_TABLES]);
  assert.equal(sample.candidateBytes, 500);
  assert.equal(sample.protectedBytes, 300);
});
