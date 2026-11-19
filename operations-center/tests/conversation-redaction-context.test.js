'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults } = require('../src/conversation-log-store');
const { maskPayload } = require('../src/services/conversation-redaction');

function mask(request, response = '{}') {
  const result = maskPayload({request:Buffer.from(request),response:Buffer.from(response),frames:[]}, defaults, Buffer.alloc(32,1));
  return {request:JSON.parse(result.payload.request),response:result.payload.response.toString(),hits:result.hits};
}

test('native Claude tool definitions, choices, calls and references stay connected without learning tool names as people', () => {
  const names = ['Read','Bash','Write','Agent',...Array.from({length:131},(_,i) => 'tool_' + i)];
  const tools = names.map(name => ({name,description:'Use ' + name,input_schema:{type:'object',properties:{query:{type:'string'}}}}));
  const messages = Array.from({length:421},(_,i) => ({role:'assistant',content:[{type:'tool_use',id:'toolu_' + i,name:names[i % names.length],input:{query:'Read the file; contact alice@example.com'}}]}));
  const source = {model:'claude-opus-5-5',tools,tool_choice:{type:'tool',name:'Read'},messages,customer:{name:'张三',email:'alice@example.com'},note:'张三 will use Read and Bash'};
  const result = mask(JSON.stringify(source), 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Read and Bash"}}\n\n');
  assert.deepEqual(result.request.tools,tools);assert.equal(result.request.tool_choice.name,'Read');
  for (const message of result.request.messages) {
    const call = message.content[0];assert(names.includes(call.name));assert(result.request.tools.some(tool => tool.name === call.name));
    assert(call.input.query.startsWith('Read the file;'));assert(!call.input.query.includes('alice@example.com'));
  }
  assert(!result.request.note.includes('张三'));assert(result.request.note.endsWith('will use Read and Bash'));
  assert(result.response.includes('Read and Bash'));assert(!result.hits.some(hit => hit.name === 'personal' && hit.count > 2));
  const builtins = ['computer','bash','text_editor','web_search','web_fetch','code_execution','memory','tool_search_tool_regex','tool_search_tool_bm25'].map(name => ({type:name + '_20261119',name}));
  assert.deepEqual(mask(JSON.stringify({model:'claude-opus-5-5',tools:builtins})).request.tools,builtins);
});

test('dates, UUIDs, process tables, runtime parameters, working directories and variable expressions remain literal', () => {
  const content = [
    '2026-11-19 18:27:06.823', '2026-11-19T18:27:06Z', '81c0320a-0508-40b9-e5f1-1294d3ca013f',
    '1234  12345  13800138000  0.0  cmd', 'bytes=1794806368560', 'size=13800138000',
    'https://service.example/?pageId=13800138000&offset=1234567890',
    '--pseudonymization-salt-handle=1234,4111111111111111111,4111111111111111,1',
    'PWD=/srv/project OLDPWD=/srv/other', 'req.Password == ""', 'password==', '==',
    'password=$DBPASS', 'password=${PGPASSWORD:-}', 'password=$POSTGRES_PASSWORD', 'password=...',
    'Cookie: _AJSESSIONID=', '`git@github.com:example/project.git` ssh://git@github.com/example/project.git',
    '127.0.0.1 127.0.1.2 0.0.0.0 ::1 :: localhost'
  ].join('\n');
  const output = mask(JSON.stringify({content,PWD:'/srv/project',OLDPWD:'/srv/other',result:{id:1,rows:42}}));
  assert.equal(output.request.content,content);assert.equal(output.request.PWD,'/srv/project');assert.equal(output.request.result.id,1);
  assert.deepEqual(output.hits,[]);
});

test('real credentials and personal identifiers remain protected in code, nested tool data and prose', () => {
  const content = 'password=fictional-password; OTP=246810; Cookie: session=fictional-session\n' +
    'const password="fictional-code-password"; git clone https://user:fictional-git-password@host.example/repo\n' +
    'contact +1-202-555-0148 or 13800138000, card 4111 1111 1111 1111; alice@example.com 10.20.30.40 2001:db8::1234';
  const output = mask(JSON.stringify({content,customer:{id:123,name:'张三'},payload:JSON.stringify({name:'张三',id:'private-client-id',otp:246810}),password:'$DBPASS'}));
  for (const value of ['fictional-password','246810','fictional-session','fictional-code-password','fictional-git-password','202-555-0148','13800138000','4111 1111 1111 1111','alice@example.com','10.20.30.40','2001:db8::1234']) assert(!output.request.content.includes(value),value);
  assert.match(output.request.customer.id,/^<IDENTITY_/);assert.match(JSON.parse(output.request.payload).id,/^<IDENTITY_/);
  assert.equal(output.request.password,'$DBPASS');
});

test('business names and IDs cannot bypass protection by posing as protocol objects inside tool data', () => {
  const inner = {tools:[{name:'张三',input_schema:{type:'object'}}],id:'private-client-id'};
  const output = mask(JSON.stringify({model:'claude-opus-5-5',messages:[{role:'tool',content:JSON.stringify(inner)}]}));
  const saved = JSON.parse(output.request.messages[0].content);assert.match(saved.tools[0].name,/^<PERSONAL_/);assert.match(saved.id,/^<IDENTITY_/);
});

test('adjacent phones, international landlines and grouped country codes are protected without swallowing dates or columns', () => {
  for (const content of ['13800138000 13900139000','+1-202-555-0148 13800138000','+1 (202) 555-0148','+44 20 7946 0958','010-12345678']) {
    const saved = mask(JSON.stringify({content})).request.content;assert(!/\d{4}/.test(saved.replace(/<PHONE_[A-F0-9]{12}>/g,'')),content);assert(saved.includes('<PHONE_'),content);
  }
  const columns = '1234  12345  13800138000  0.0';assert.equal(mask(JSON.stringify({content:columns})).request.content,columns);
});
