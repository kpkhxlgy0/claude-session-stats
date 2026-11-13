'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const {startRenderer}=require('../src/renderer.cjs');
const LOCAL='local_11111111-1111-4111-8111-111111111111';
test('visible renderer renews its owner lease and releases it immediately on hidden and stop',async t=>{const dom=new JSDOM('<main><form><div class="ProseMirror" contenteditable="true"></div><button type="submit">Send</button></form></main>',{url:`https://claude.ai/code/${LOCAL}`});t.after(()=>dom.window.close());for(const node of dom.window.document.querySelectorAll('form,.ProseMirror,button')){node.getClientRects=()=>[{width:600,height:100}];node.getBoundingClientRect=()=>({width:600,height:100,left:0,right:600,top:500,bottom:600});}const calls=[];const controller=startRenderer({ipc:{async invoke(channel,arg){calls.push([channel,arg]);if(channel==='stats-interest')return true;if(channel==='stats')return {status:'ok',threadId:arg.sessionId};return null;}}},{window:dom.window,pollMs:100000,debounceMs:0});t.after(()=>controller.stop());await new Promise(r=>setTimeout(r,25));const interest=calls.find(([name])=>name==='stats-interest');assert.deepEqual(interest[1].targets,[{localSessionId:LOCAL}]);assert.equal(calls.find(([name])=>name==='stats')[1].owner,interest[1].owner);Object.defineProperty(dom.window.document,'visibilityState',{value:'hidden',configurable:true});dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));assert.ok(calls.some(([name,arg])=>name==='stats-release'&&arg.owner===interest[1].owner));controller.stop();});

test('a visible local owner renews while its source request is still pending', async t => {
    const dom=new JSDOM('<form><div class="ProseMirror" contenteditable="true"></div><button>Send</button></form>',{url:`https://claude.ai/code/${LOCAL}`});
    t.after(()=>dom.window.close());for(const node of dom.window.document.querySelectorAll('form,.ProseMirror,button')){node.getClientRects=()=>[{width:600,height:100}];node.getBoundingClientRect=()=>({width:600,height:100});}
    let renewals=0,reads=0;
    const controller=startRenderer({ipc:{invoke(channel){if(channel==='stats-interest'){renewals++;return Promise.resolve(true);}if(channel==='stats'){reads++;return new Promise(()=>{});}return Promise.resolve(null);}}},{window:dom.window,pollMs:10,debounceMs:0});
    t.after(()=>controller.stop());await new Promise(resolve=>setTimeout(resolve,55));
    assert.equal(reads,1);assert.ok(renewals>=3,`Only ${renewals} renewals while a visible source was pending`);
});
