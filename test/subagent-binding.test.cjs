'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const LOCAL = 'local_11111111-1111-4111-8111-111111111111';
const REMOTE = 'session_Abc123-remote_01';

function fixture(t, { remote = false, kind = 'subagent' } = {}) {
    const sessionId = remote ? REMOTE : LOCAL;
    const dom = new JSDOM('<section data-pane-root data-perf-screen="tasks"></section>',
        { url: `https://claude.ai/${remote ? 'code' : 'epitaxy'}/${sessionId}` });
    t.after(() => dom.window.close());
    const pane = dom.window.document.querySelector('section');
    pane.getClientRects = () => [{ width: 600, height: 400 }];
    const sessionRef = { type: remote ? 'bridge' : 'local', id: sessionId };
    const view = { view: { kind, toolUseId: 'toolu_selected', description: 'private task text' }, sessionRef };
    const detail = { openedToolUseId: 'toolu_selected', sessionRef,
        paneView: { agentId: 'agent_A-1' }, task: { taskId: 'agent_A-1', toolUseId: 'toolu_selected' } };
    const host = { tag: 5, stateNode: pane, memoizedProps: {} };
    const root = { tag: 3, stateNode: {}, child: host }; root.stateNode.current = root; host.return = root;
    pane.__reactFiber$fixture = host;
    function props(...values) {
        let previous;
        host.child = null;
        for (const value of values) {
            const fiber = { tag: 0, memoizedProps: value, return: host };
            if (previous) previous.sibling = fiber; else host.child = fiber;
            previous = fiber;
        }
    }
    props(view, detail);
    return { dom, pane, host, root, view, detail, sessionId, props };
}

function bindings() { return require('../src/subagent-binding.cjs').createSubagentBindings(); }

test('binds only the exact selected subagent in a pane to its matching detail identity', t => {
    for (const remote of [false, true]) {
        const f = fixture(t, { remote });
        assert.deepEqual(bindings().resolveSubagent(f.pane, f.dom.window),
            { sessionId: f.sessionId, agentId: 'agent_A-1', remote });
    }
});

test('route identity and matching titles cannot replace the selected view/detail relationship', t => {
    const f = fixture(t);
    for (const props of [[f.view], [f.detail], [{ ...f.view, view: { kind: 'tasks' } }, f.detail],
        [f.view, { ...f.detail, openedToolUseId: 'toolu_other' }]]) {
        f.props(...props);
        assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
    }
});

test('rejects contradictory detail, route, cloud and malformed agent identities', t => {
    const f = fixture(t);
    for (const change of [
        { paneView: { agentId: '../other' } }, { paneView: { agentId: 'a'.repeat(65) } },
        { paneView: { agentId: '代理' } }, { paneView: { agentId: '' } },
        { task: { taskId: 'another', toolUseId: 'toolu_selected' } },
        { task: { taskId: 'agent_A-1', toolUseId: 'toolu_other' } },
        { sessionRef: { type: 'cloud', id: LOCAL } },
        { sessionRef: { type: 'bridge', id: LOCAL } },
        { sessionRef: { type: 'local', id: 'local_22222222-2222-4222-8222-222222222222' } },
    ]) {
        f.props(f.view, { ...f.detail, ...change });
        assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null, JSON.stringify(change));
    }
    f.props(f.view, f.detail);
    f.dom.window.history.pushState({}, '', '/new');
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
});

test('rejects conflicting selected views and matching details instead of choosing the first', t => {
    const f = fixture(t);
    f.props(f.view, f.detail, { ...f.detail, paneView: { agentId: 'other' }, task: undefined });
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
    f.props(f.view, f.detail, { ...f.view, view: { kind: 'subagent', toolUseId: 'toolu_other' } });
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
});

test('reads committed memoized props and ignores pending props and stale alternate branches', t => {
    const f = fixture(t);
    const oldHost = { tag: 5, stateNode: f.pane, memoizedProps: f.view, return: { tag: 3, stateNode: f.root.stateNode } };
    oldHost.alternate = f.host; f.host.alternate = oldHost; f.pane.__reactFiber$fixture = oldHost;
    oldHost.child = { memoizedProps: { ...f.detail, paneView: { agentId: 'old' }, task: undefined }, return: oldHost };
    f.host.pendingProps = { ...f.view, view: { kind: 'subagent', toolUseId: 'pending' } };
    assert.deepEqual(bindings().resolveSubagent(f.pane, f.dom.window),
        { sessionId: LOCAL, agentId: 'agent_A-1', remote: false });
    f.root.stateNode.current = {};
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
});

test('never borrows identities from nested panes, ancestors, or an oversized Fiber tree', t => {
    const f = fixture(t);
    const nested = f.dom.window.document.createElement('section'); nested.dataset.paneRoot = '';
    f.pane.append(nested);
    f.props(f.view);
    f.host.child.sibling = { tag: 5, stateNode: nested, return: f.host,
        child: { tag: 0, memoizedProps: f.detail } };
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
    f.props(f.detail); f.root.memoizedProps = f.view;
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
    f.props(f.view, f.detail);
    let tail = f.host.child.sibling;
    for (let index = 0; index < 3001; index++) { tail.sibling = { tag: 0, memoizedProps: {}, return: f.host }; tail = tail.sibling; }
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
});

test('readBindings exports only visible uniquely keyed pane identities and is self-contained', t => {
    const f = fixture(t, { remote: true });
    f.pane.dataset.sessionStatsKey = 'ss_pane_1';
    const { createSubagentBindings } = require('../src/subagent-binding.cjs');
    const serialized = vm.runInNewContext(`(${createSubagentBindings.toString()})()`, { window: f.dom.window });
    assert.deepEqual(JSON.parse(JSON.stringify(serialized.readBindings())), [{ key: 'ss_pane_1',
        bound: { sessionId: REMOTE, agentId: 'agent_A-1', remote: true } }]);
    assert.doesNotMatch(JSON.stringify(serialized.readBindings()), /toolu_|private task text|sessionRef|paneView/);
    f.pane.hidden = true;
    assert.deepEqual(JSON.parse(JSON.stringify(serialized.readBindings())), []);
    f.pane.hidden = false;
    f.pane.dataset.sessionStatsKey = '../unsafe';
    assert.deepEqual(JSON.parse(JSON.stringify(serialized.readBindings())), []);
    f.pane.dataset.sessionStatsKey = 'ss_pane_1';
    const other = f.pane.cloneNode(); other.getClientRects = f.pane.getClientRects;
    f.dom.window.document.body.append(other);
    assert.deepEqual(JSON.parse(JSON.stringify(serialized.readBindings())), []);
});

test('a task-list view cannot borrow a retained descendant subagent view', t => {
    const f = fixture(t);
    f.props({ ...f.view, view: { kind: 'tasks' } }, f.view, f.detail);
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
});
