'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {startMain}=require('../src/main.cjs');
const LOCAL='local_11111111-1111-4111-8111-111111111111';
const CLI='22222222-2222-4222-8222-222222222222';
const AGENT='aa6fe20fa9956750a';

function fixture(t,extra={}) {
    const handlers=new Map(),calls=[];
    const api={manifest:{id:'com.kpk.session-stats'},ipc:{handle:(key,fn)=>handlers.set(key,fn)},log:{info(){}}};
    const controller=startMain(api,{claudeData:'unused',claudeHome:'unused',
        ipcMain:{handle(){},removeHandler(){}},resolveSession:async()=>CLI,
        publisher:{start(){},stop(){},readLocal:async()=>null},
        store:{getStats(){assert.fail('must not substitute parent stats');},
            async getAgentStats(parent,agentId){calls.push([parent,agentId]);return{status:'ok',threadId:parent,agentId,turns:1,tps:42};},dispose(){}},
        ...extra});
    t.after(()=>controller.stop());
    return {read:arg=>handlers.get('agent-stats')?.(arg),calls,controller,handlers};
}
test('local child IPC maps parent identity and returns only the requested child',async t=>{
    const f=fixture(t);
    assert.deepEqual(await f.read({sessionId:LOCAL,agentId:AGENT}),{status:'ok',threadId:LOCAL,agentId:AGENT,turns:1,tps:42});
    assert.deepEqual(f.calls,[[CLI,AGENT]]);
});
test('local child IPC rejects unsafe child IDs and never falls back to parent metrics',async t=>{
    const f=fixture(t);
    for(const agentId of ['',null,'../other','a/b','a.b','x'.repeat(65)])
        assert.equal((await f.read({sessionId:LOCAL,agentId}))?.status,'unavailable');
    assert.equal((await f.read({sessionId:'session_remote',agentId:AGENT}))?.status,'unavailable');
    assert.deepEqual(f.calls,[]);
});
test('local child IPC uses the exact published child sample without recomputing',async t=>{
    const seen=[];
    const sample={status:'ok',agentId:AGENT,turns:2,tps:55,snapshotRevision:7};
    const f=fixture(t,{publisher:{start(){},stop(){},async readLocal(id,options){seen.push({id,options});return sample;}}});
    assert.deepEqual(await f.read({sessionId:LOCAL,agentId:AGENT}),{...sample,threadId:LOCAL});
    assert.deepEqual(seen,[{id:LOCAL,options:{agentId:AGENT,waitForPoll:false}}]);
    assert.deepEqual(f.calls,[]);
});
test('a mismatched published child and changed Desktop mapping fail closed',async t=>{
    const f=fixture(t,{publisher:{start(){},stop(){},readLocal:async()=>({status:'ok',agentId:'other',turns:99})}});
    assert.equal((await f.read({sessionId:LOCAL,agentId:AGENT}))?.status,'unavailable');
    assert.deepEqual(f.calls,[]);
    let mappings=0;
    const g=fixture(t,{resolveSession:async()=>++mappings===1?CLI:null});
    assert.equal((await g.read({sessionId:LOCAL,agentId:AGENT}))?.status,'unavailable');
});
test('child IPC and frame bridges clean up when the tweak stops',async t=>{
    const raw=new Map();
    const f=fixture(t,{ipcMain:{handle:(k,v)=>raw.set(k,v),removeHandler:k=>raw.delete(k)}});
    assert.ok(raw.has('claudepp:com.kpk.session-stats:agent-bindings'));
    assert.ok(raw.has('claudepp:com.kpk.session-stats:remote-agent-stats'));
    f.controller.stop();assert.equal(raw.size,0);
    assert.equal((await f.read({sessionId:LOCAL,agentId:AGENT}))?.status,'unavailable');
});
