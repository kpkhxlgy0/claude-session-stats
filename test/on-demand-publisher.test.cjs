'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
const LOCAL='local_44444444-4444-4444-8444-444444444444', OTHER='local_55555555-5555-4555-8555-555555555555';
const CLI='33333333-3333-4333-8333-333333333333', ACCOUNT='11111111-1111-4111-8111-111111111111', ORG='22222222-2222-4222-8222-222222222222';
const STATS={status:'ok',usageComplete:true,turns:1,steps:1,totalTokens:3,inputTokens:1,outputTokens:2,cachedInputTokens:0,cacheHit:0,tps:1};
async function fixture(t, store={}, options={}) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'claude-stats-demand-'))),claudeData=path.join(root,'desktop'),claudeHome=path.join(root,'home'),workspace=path.join(root,'work');
 const dir=path.join(claudeData,'claude-code-sessions',ACCOUNT,ORG); await fs.mkdir(dir,{recursive:true});await fs.mkdir(workspace);await fs.mkdir(claudeHome);
 for(const [local,cli,bridge] of [[LOCAL,CLI,'session_current'],[OTHER,ACCOUNT,'session_history']])await fs.writeFile(path.join(dir,`${local}.json`),JSON.stringify({sessionId:local,cliSessionId:cli,cwd:workspace,bridgeSessionIds:[bridge]}));
 const calls=[];let time=100000;
 const publisher=createSnapshotPublisher({claudeData,claudeHome,now:()=>time,pollMs:10,store:{
  async getStats(id,context){calls.push(['parent',id]); assert.equal(await context.verify(),true); return {...STATS,threadId:id};},
  async getAgentStats(id,agentId,context){calls.push(['child',id,agentId]);assert.equal(await context.verify(),true);return {...STATS,threadId:id,agentId};},
  async listAgents(){throw new Error('Demand must never discover the child population');},...store},...options});
 t.after(async()=>{await publisher.stop();await fs.rm(root,{recursive:true,force:true});});return {publisher,calls,claudeHome,metadata:dir,workspace,setTime:v=>time=v};
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('a delayed parent discovery cannot overwrite a newer selected-child workspace discovery', async t => {
 let entered,release,f,first=true;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const resolver={async resolveVerified(){if(first){first=false;entered();await gate;return {workspaceRoot:f.workspace,evidenceKey:'old'};}return {workspaceRoot:path.join(f.workspace,'new'),evidenceKey:'new'};}};
 f=await fixture(t,{}, {resolveWorkspace:resolver,pollMs:60000});await fs.mkdir(path.join(f.workspace,'new'));
 f.publisher.setInterest('windowA',[{localSessionId:LOCAL},{localSessionId:LOCAL,agentId:'selected'}]);
 const parent=f.publisher.readLocal(LOCAL,{owner:'windowA'});await ready;
 assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowA',agentId:'selected'})).status,'ok');
 release();await parent;
 assert.equal(f.calls.filter(call=>call[0]==='parent').length,0);
 assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowA',agentId:'selected',waitForPoll:false})).status,'ok');
});
test('idle startup and repeated ticks perform no source reads or snapshot writes',async t=>{const f=await fixture(t);await f.publisher.start();await wait(35);assert.deepEqual(f.calls,[]);await assert.rejects(fs.stat(path.join(f.claudeHome,'.session-stats')),{code:'ENOENT'});});
test('an owner requests only its exact parent and selected child without discovering history or siblings',async t=>{const f=await fixture(t);assert.equal(f.publisher.setInterest('windowA',[{localSessionId:LOCAL},{localSessionId:LOCAL,agentId:'selected'}]),true);await f.publisher.start();assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowA'})).status,'ok');assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowA',agentId:'selected'})).status,'ok');assert.ok(f.calls.every(call=>call[1]===CLI));assert.ok(f.calls.some(call=>call[0]==='child'&&call[2]==='selected'));f.publisher.releaseInterest('windowA');const count=f.calls.length;await wait(35);assert.equal(f.calls.length,count);});
test('one window release cannot cancel another window and an expired lease stops reads',async t=>{const f=await fixture(t);f.publisher.setInterest('windowA',[{localSessionId:LOCAL}]);f.publisher.setInterest('windowB',[{localSessionId:LOCAL}]);await f.publisher.start();f.publisher.releaseInterest('windowA');assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowB'})).status,'ok');assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowA'})).status,'unavailable');f.setTime(108001);await f.publisher.start();const count=f.calls.length;await wait(25);assert.equal(f.calls.length,count);assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowB'})).status,'unavailable');});
test('release during source I/O invalidates a late sample before any snapshot publication',async t=>{let entered,release;const ready=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);const f=await fixture(t,{async getStats(id){entered();await blocked;return {...STATS,threadId:id};}});f.publisher.setInterest('windowA',[{localSessionId:LOCAL}]);const starting=f.publisher.start();await ready;f.publisher.releaseInterest('windowA');release();await starting;assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowA'})).status,'unavailable');assert.equal(await fs.readdir(path.join(f.claudeHome,'.session-stats')).catch(()=>[]).then(rows=>rows.length),0);});

test('a fresh exact binding can recover after one failed final confirmation',async t=>{let f,change=false;f=await fixture(t,{async getStats(id,context){assert.equal(await context.verify(),true);if(change){change=false;const file=path.join(f.metadata,`${LOCAL}.json`);const row=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...row,remoteControlUserEnabled:false}));}return {...STATS,threadId:id};}});f.publisher.setInterest('windowA',[{localSessionId:LOCAL}]);await f.publisher.start();change=true;await f.publisher.start();const file=path.join(f.metadata,`${LOCAL}.json`),row=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...row,remoteControlUserEnabled:true}));assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowA'})).status,'ok');});
test('an existing local-only sample cannot survive a CLI mapping change during its next read',async t=>{let f,change=false;f=await fixture(t,{async getStats(id){if(change){const file=path.join(f.metadata,`${LOCAL}.json`),row=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...row,cliSessionId:ACCOUNT}));}return {...STATS,threadId:id};}});const file=path.join(f.metadata,`${LOCAL}.json`),row=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...row,bridgeSessionIds:[]}));f.publisher.setInterest('windowA',[{localSessionId:LOCAL}]);assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowA'})).status,'ok');change=true;assert.equal((await f.publisher.readLocal(LOCAL,{owner:'windowA'})).status,'unavailable');});

test('renewing a visible lease preserves one slow exact source operation beyond the original eight seconds', async t => {
    // Drive this lease test explicitly so a later periodic refresh cannot race its read count.
    t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
    let entered,release,f,reads=0;
    const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    f=await fixture(t,{async getStats(id,context){reads++;entered();await gate;assert.equal(await context.verify(),true);return {...STATS,threadId:id};}});
    f.publisher.setInterest('slow_viewer',[{localSessionId:LOCAL}]);const pending=f.publisher.start();await ready;
    for(const time of [103000,106000,109000,112000]){f.setTime(time);f.publisher.setInterest('slow_viewer',[{localSessionId:LOCAL}]);}
    release();await pending;
    assert.equal((await f.publisher.readLocal(LOCAL,{owner:'slow_viewer',waitForPoll:false})).status,'ok');assert.equal(reads,1);
    f.publisher.releaseInterest('slow_viewer');const count=reads;await f.publisher.start();assert.equal(reads,count);
});
