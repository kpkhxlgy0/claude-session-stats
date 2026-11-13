'use strict';
const { test }=require('node:test'),assert=require('node:assert/strict');
const { createDemandProtocol }=require('../src/demand-protocol.cjs');
const p=createDemandProtocol(),expected={bridgeSessionId:'session_current',organizationId:'11111111-1111-4111-8111-111111111111',now:100000};
test('remote viewer requests use independent keys and a bounded exact target lease',()=>{const value={protocolVersion:1,viewerId:'windowA',...expected,expiresAt:108000,agentId:'selected'};delete value.now;assert.deepEqual(p.parse(value,expected),value);assert.notEqual(p.key('windowA'),p.key('windowB'));for(const change of [{expiresAt:100000},{expiresAt:108001},{agentId:'../x'},{organizationId:'other'},{bridgeSessionId:'session_other'},{extra:true}])assert.equal(p.parse({...value,...change},expected),null);});
