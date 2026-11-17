'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {ConversationLogStore} = require('../src/conversation-log-store');
function block() {
  process.send?.({type:'fixture-blocked'});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
}
const list = ConversationLogStore.prototype.list;
ConversationLogStore.prototype.list = function(query) {
  if (query.search === '__fixture_block__') block();
  return list.call(this,query);
};
const backfill = ConversationLogStore.prototype.backfillMetadata;
ConversationLogStore.prototype.backfillMetadata = function() {
  if (fs.existsSync(path.join(this.directory,'fixture-block-backfill'))) block();
  return backfill.call(this);
};
require('../src/services/conversation-read-worker');
