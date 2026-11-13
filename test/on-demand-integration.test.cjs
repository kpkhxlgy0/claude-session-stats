'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { createSessionStore } = require('../src/session-store.cjs');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
const { createCliWorkspaceResolver } = require('../src/cli-workspace.cjs');
const { createRemoteDemand } = require('../src/remote-demand.cjs');
const { createRemoteReader } = require('../src/remote-reader.cjs');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const { createMetadataApi } = require('./helpers/metadata-api.cjs');
const LOCAL='local_11111111-1111-4111-8111-111111111111',CLI='22222222-2222-4222-8222-222222222222';
const ORG='33333333-3333-4333-8333-333333333333',ACCOUNT='44444444-4444-4444-8444-444444444444',BRIDGE='session_ColdDemand';
test('cold remote demand computes only the viewed exact files and every viewer can release independently', async t => {
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'claude-cold-demand-')));
    const claudeData=path.join(root,'desktop'),claudeHome=path.join(root,'home'),workspace=path.join(root,'workspace');
    const metadata=path.join(claudeData,'claude-code-sessions',ACCOUNT,ORG),logs=path.join(claudeHome,'projects','project');
    const children=path.join(logs,CLI,'subagents'),registry=path.join(claudeHome,'sessions');
    for(const directory of [metadata,children,registry,workspace])await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(metadata,LOCAL+'.json'),JSON.stringify({sessionId:LOCAL,cliSessionId:CLI,cwd:workspace,bridgeSessionIds:[BRIDGE]}));
    await fs.writeFile(path.join(registry,'101.json'),JSON.stringify({pid:101,sessionId:CLI,hostSessionId:LOCAL,bridgeSessionId:BRIDGE,
        procStart:'123456',pidDomain:'win32:fixture-host',startedAt:1,cwd:workspace}));
    const row=(agentId,output)=>JSON.stringify({type:'assistant',sessionId:CLI,uuid:agentId??'parent',
        ...(agentId?{agentId,isSidechain:true}:{}),message:{role:'assistant',model:'test',id:agentId??'parent',usage:{input_tokens:10,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:output}}})+'\n';
    await fs.writeFile(path.join(logs,CLI+'.jsonl'),row(null,40));
    await fs.writeFile(path.join(children,'agent-selected.jsonl'),row('selected',7));
    const sibling=path.join(children,'agent-unselected.jsonl');await fs.writeFile(sibling,row('unselected',99));
    let logReads=0,siblingReads=0;
    const open=fs.open;
    t.mock.method(fs,'open',async(file,...args)=>{if(file.startsWith(logs)){logReads++;if(file===sibling)siblingReads++;}return open(file,...args);});
    let clock=100000;
    const store=createSessionStore({claudeHome});
    const resolver=createCliWorkspaceResolver({claudeHome,platform:'win32',hostname:'fixture-host',
        getProcessIdentities:async()=>new Map([[101,{alive:true,procStart:'123456'}]])});
    const publisher=createSnapshotPublisher({claudeData,claudeHome,store,resolveWorkspace:resolver,now:()=>clock,pollMs:100000});
    const api=createMetadataApi({bridgeSessionId:BRIDGE,organizationId:ORG,accountId:ACCOUNT,snapshotDirectory:path.join(claudeHome,'.session-stats')});
    const demand=createRemoteDemand({source:publisher,fetch:api.writerFetch,now:()=>clock,pollMs:100000});
    const dom=new JSDOM('<div class="ProseMirror" contenteditable="true"></div>',{url:`https://claude.ai/code/${BRIDGE}`});
    const editor=dom.window.document.querySelector('.ProseMirror');editor.getClientRects=()=>[{width:100}];
    editor.__reactFiber$test={return:{memoizedProps:{value:{activeOrganization:{uuid:ORG}}}}};dom.window.fetch=api.readerFetch;
    const parent=createRemoteReader(dom.window,createSnapshotProtocol,{viewerId:'window_parent',now:()=>clock,pollMs:0});
    const child=createRemoteReader(dom.window,createSnapshotProtocol,{viewerId:'window_child',now:()=>clock,pollMs:0,
        resolveAgent:()=>({sessionId:BRIDGE,agentId:'selected',remote:true})});
    let control=Promise.resolve();
    api.onDemand(()=>{control=demand.refresh();return control;});
    t.after(async()=>{parent.stop();child.stop();await demand.stop();await control;dom.window.close();await publisher.stop();store.dispose();await fs.rm(root,{recursive:true,force:true});});
    await publisher.start();await demand.start();
    assert.equal(logReads,0);assert.equal(api.envelope().protocolVersion,2);
    // Demand PUT completes before the producer pump. Missing is retried quickly
    // under the still-visible lease, with a new native request each time.
    assert.equal((await parent.read()).unavailableReason,'snapshot-missing');
    await publisher.start(); clock+=1000;
    assert.equal((await parent.read()).totalTokens,50);
    assert.equal((await child.read()).unavailableReason,'snapshot-missing');
    await publisher.start(); clock+=1000;
    assert.equal((await child.read()).totalTokens,17);assert.equal(siblingReads,0);
    assert.equal(new Set(api.reads().map(value=>value.requestId)).size,api.reads().length);
    parent.stop();await control;
    assert.equal((await child.read()).totalTokens,17);
    child.stop();await control;
    const before=logReads;await publisher.start();await demand.refresh();await publisher.start();
    assert.equal(logReads,before);assert.equal(siblingReads,0);
});
