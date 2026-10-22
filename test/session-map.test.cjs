'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveSession } = require('../src/session-map.cjs');
const UUID = '11111111-1111-4111-8111-111111111111';
const ID = `local_${UUID}`;
const CLI = '22222222-2222-4222-8222-222222222222';
async function fixture(t) {
    const claudeData = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-map-'));
    t.after(() => fs.rm(claudeData, { recursive: true }));
    const write = async (account, row) => {
        const dir = path.join(claudeData, 'claude-code-sessions', account);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${ID}.json`), JSON.stringify(row));
    };
    return { claudeData, write };
}
test('resolves only exact persisted Desktop identity and returns only UUID', async t => {
    const { claudeData, write } = await fixture(t);
    await write('account', { sessionId: ID, cliSessionId: CLI, title: 'private title', cwd: 'private path' });
    assert.equal(await resolveSession(claudeData, ID), CLI);
});
test('resolves current account/organization metadata layout', async t => {
    const { claudeData, write } = await fixture(t);
    await write('account/organization', { sessionId: ID, cliSessionId: CLI });
    assert.equal(await resolveSession(claudeData, ID), CLI);
});
test('rejects missing, conflicting and invalid metadata', async t => {
    const { claudeData, write } = await fixture(t);
    assert.equal(await resolveSession(claudeData, ID), null);
    for (const row of [{ sessionId: ID }, { sessionId: `local_${CLI}`, cliSessionId: CLI },
        { sessionId: ID, cliSessionId: '../private' }, null]) {
        await write('account', row); assert.equal(await resolveSession(claudeData, ID), null);
    }
});
test('duplicate Desktop keys across accounts are ambiguous even with same UUID', async t => {
    const { claudeData, write } = await fixture(t);
    await write('one', { sessionId: ID, cliSessionId: CLI });
    await write('two', { sessionId: ID, cliSessionId: CLI });
    assert.equal(await resolveSession(claudeData, ID), null);
});
test('re-reads changed mapping and refuses traversal and nonlocal IDs', async t => {
    const { claudeData, write } = await fixture(t);
    await write('one', { sessionId: ID, cliSessionId: CLI });
    assert.equal(await resolveSession(claudeData, ID), CLI);
    await write('one', { sessionId: ID, cliSessionId: UUID });
    assert.equal(await resolveSession(claudeData, ID), UUID);
    for (const id of [null, '../private', UUID, `${ID}/extra`, `${ID}.json`])
        assert.equal(await resolveSession(claudeData, id), null);
});
