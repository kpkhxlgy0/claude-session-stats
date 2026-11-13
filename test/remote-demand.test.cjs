'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRemoteDemand}=require('../src/remote-demand.cjs');
const ORG='11111111-1111-4111-8111-111111111111',ACCOUNT='22222222-2222-4222-8222-222222222222';
const bound={bridgeSessionId:'session_active',organizationId:ORG,accountId:ACCOUNT,localSessionId:'local_44444444-4444-4444-8444-444444444444'};
test('cold location advertisement and exact remote leases need no precomputed sample',async t=>{const interests=[],released=[],calls=[],container={sibling:{untouched:true},claudepp_session_stats_request_viewerA:{protocolVersion:1,viewerId:'viewerA',bridgeSessionId:bound.bridgeSessionId,organizationId:ORG,expiresAt:108000,agentId:'selected'}};const source={async listActiveRemoteBindings(){return [bound];},async readRemoteLocation(){return {bridgeSessionId:bound.bridgeSessionId,organizationId:ORG,publisherId:ACCOUNT,generatedAt:100000,directory:'C:/home/.session-stats'};},setInterest(...args){interests.push(args);},releaseInterest(owner){released.push(owner);}};const service=createRemoteDemand({source,now:()=>100000,pollMs:100000,fetch:async(url,init)=>{calls.push(init);assert.equal(init.headers['X-Expected-Account'],ACCOUNT);if(init.method==='PUT'){const patch=JSON.parse(init.body).client_metadata_patch;assert.equal(patch.at(-1).path,'/claudepp_session_stats');container.claudepp_session_stats=patch.at(-1).value;}return new Response(JSON.stringify({session:{id:'cse_active',environment_kind:'bridge',connection_status:'connected',client_metadata:container}}));}});t.after(()=>service.stop());await service.start();assert.equal(calls.filter(c=>c.method==='PUT').length,1);assert.deepEqual(interests[0][1],[{localSessionId:bound.localSessionId,agentId:'selected'}]);assert.deepEqual(container.sibling,{untouched:true});delete container.claudepp_session_stats_request_viewerA;await service.refresh();assert.ok(released.includes(interests[0][0]));});
test('no active local CLI bridge means no cloud request and no statistics interest',async t=>{let calls=0;const service=createRemoteDemand({source:{async listActiveRemoteBindings(){return [];},setInterest(){throw Error('idle');},releaseInterest(){}},fetch:async()=>{calls++;},pollMs:100000});t.after(()=>service.stop());await service.start();await service.refresh();assert.equal(calls,0);});

test('a fresh descriptor owned by another producer cannot be replaced or grant this producer a demand', async t => {
    const interests = [], calls = [];
    const existing = { protocolVersion: 2, bridgeSessionId: bound.bridgeSessionId, organizationId: ORG,
        publisherId: ORG, generatedAt: 100000, directory: 'C:/other/.session-stats' };
    const source = { listActiveRemoteBindings: async () => [bound], setInterest: (...args) => interests.push(args), releaseInterest() {},
        readRemoteLocation: async () => ({ bridgeSessionId: bound.bridgeSessionId, organizationId: ORG,
            publisherId: ACCOUNT, generatedAt: 100000, directory: 'C:/home/.session-stats' }) };
    const service = createRemoteDemand({ source, now: () => 100000, pollMs: 100000, fetch: async (_url, init) => {
        calls.push(init.method); return new Response(JSON.stringify({ session: { id: bound.bridgeSessionId,
            environment_kind: 'bridge', connection_status: 'connected', client_metadata: { claudepp_session_stats: existing } } }));
    } });
    t.after(() => service.stop()); await service.start();
    assert.deepEqual(calls, ['GET']); assert.equal(interests.length, 0);
});

test('a timed-out first bridge cannot revoke an unvisited second bridge or extend its existing lease', async t => {
    const other = { ...bound, bridgeSessionId: 'session_second', localSessionId: 'local_55555555-5555-4555-8555-555555555555' };
    const leases = [], releases = []; let fail = false;
    const setTimeout = global.setTimeout;
    t.mock.method(global, 'setTimeout', (callback, ms, ...args) => setTimeout(callback, fail && ms === 5000 ? 5 : ms, ...args));
    const service = createRemoteDemand({ now: () => 100000, pollMs: 100000, source: {
        listActiveRemoteBindings: async () => [bound, other],
        setInterest: (...args) => leases.push(args), releaseInterest: owner => releases.push(owner),
        readRemoteLocation: async (bridgeSessionId) => ({ bridgeSessionId, organizationId: ORG,
            publisherId: ACCOUNT, generatedAt: 100000, directory: 'C:/home/.session-stats' }),
    }, fetch: async (url, init) => {
        if (fail) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('timeout')), { once: true }));
        const active = url.endsWith(other.bridgeSessionId) ? other : bound;
        return new Response(JSON.stringify({ session: { id: active.bridgeSessionId, environment_kind: 'bridge', connection_status: 'connected',
            client_metadata: { claudepp_session_stats_request_viewer: { protocolVersion: 1, viewerId: 'viewer',
                bridgeSessionId: active.bridgeSessionId, organizationId: ORG, expiresAt: 108000 } } } }));
    } });
    t.after(() => service.stop()); await service.start();
    // Both valid viewer leases keep their original expiry after an incomplete poll.
    assert.equal(leases.length, 2); fail = true; await service.refresh();
    assert.equal(releases.length, 0); assert.equal(leases.length, 2);
    assert.ok(leases.every(value => value[2].expiresAt === 108000));
});

test('the demand deadline settles even when a native fetch ignores its abort signal', { timeout: 1000 }, async t => {
    const nativeTimeout = global.setTimeout;
    t.mock.method(global, 'setTimeout', (callback, ms, ...args) => nativeTimeout(callback, ms === 5000 ? 5 : ms, ...args));
    const service = createRemoteDemand({ source: { listActiveRemoteBindings: async () => [bound],
        setInterest() { assert.fail('A timed-out GET cannot grant demand'); }, releaseInterest() {} },
        fetch: () => new Promise(() => {}) });
    t.after(() => service.stop()); await service.refresh();
});
