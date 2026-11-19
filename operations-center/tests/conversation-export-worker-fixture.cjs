'use strict';

const {ConversationExportData,failure}=require('../src/services/conversation-export-data');
const memory=require('../src/services/conversation-memory'),budget=memory.processingBudget;
let blocked=true;
memory.processingBudget=(...args)=>blocked?16*1024**2:budget(...args);
process.on('message',message=>{if(message?.type==='fixture-release-memory')blocked=false;});
const envelope=ConversationExportData.prototype.envelope;
ConversationExportData.prototype.envelope=function(selection,row) {
  process.send?.({type:'fixture-export-prepare'});
  if(blocked)throw failure('MEMORY','Fixture memory pressure');
  return envelope.call(this,selection,row);
};
require('../src/services/conversation-export-worker');
