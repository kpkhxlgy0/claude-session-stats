'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRemoteBridge}=require('../src/remote-bridge.cjs');

test('scoped child bridge validates arguments before executing its fixed script builder',async t=>{
    const handlers=new Map(),calls=[];
    const frame={url:'https://claude.ai/epitaxy/session_example',executeJavaScript:async script=>{
        calls.push(script);return {agentId:'a123abc',privateText:'never returned'};
    }};
    const sender={mainFrame:frame};
    const controller=createRemoteBridge({ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},
        manifestId:'stats',channelName:'remote-agent-stats',script:arg=>arg?.key==='pane-1'?'fixed-child-script':null,
        project:value=>value?.agentId==='a123abc'?{agentId:value.agentId}:null});
    t.after(()=>controller.stop());
    const read=handlers.get('claudepp:stats:remote-agent-stats');
    assert.equal(typeof read,'function');
    assert.equal(await read({sender,senderFrame:frame},{key:'window.credentials'}),null);
    assert.deepEqual(calls,[]);
    assert.deepEqual(await read({sender,senderFrame:frame},{key:'pane-1'}),{agentId:'a123abc'});
    assert.deepEqual(calls,['fixed-child-script']);
    controller.stop();assert.equal(handlers.size,0);
});
