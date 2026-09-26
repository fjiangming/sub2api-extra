'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isAdminUser } = require('../src/auth');

test('administrator capability supports Sub2API role and flag variants', () => {
  assert.equal(isAdminUser({ role: 'ADMIN' }), true);
  assert.equal(isAdminUser({ role: 'root' }), true);
  assert.equal(isAdminUser({ role: 'user', is_admin: true }), true);
  assert.equal(isAdminUser({ role: 'user', isAdmin: true }), true);
  assert.equal(isAdminUser({ role: 'user' }), false);
  assert.equal(isAdminUser(null), false);
});
