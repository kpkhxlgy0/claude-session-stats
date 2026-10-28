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

function attach(parent, ...children) {
    parent.child = children[0] || null;
    children.forEach((child, index) => {
        child.return = parent; child.sibling = children[index + 1] || null;
    });
}

function presentationFixture(f, count = 12) {
    f.props(f.view);
    let controller = f.host.child;
    for (const [tag, props] of [
        [0, { sessionId: f.sessionId, sessionRef: f.view.sessionRef, children: null }],
        [10, { value: null, children: null }], [0, { value: null, children: null }],
        [10, { value: null, children: null }],
        [0, { sessionRef: f.view.sessionRef, toolUseId: 'toolu_selected' }],
        [0, { children: null }], [10, { value: null, children: null }],
        [10, { value: null, children: null }],
        [0, { sessionRef: f.view.sessionRef, toolUseId: 'toolu_selected' }],
        [10, { value: null, children: null }],
    ]) {
        const child = { tag, memoizedProps: props };
        attach(controller, child); controller = child;
    }
    const detail = { tag: 0, memoizedProps: { ...f.detail, messages: [], drawnEntries: [] } };
    let rendered = { tag: 10, memoizedProps: { value: null, children: null } };
    attach(controller, detail, rendered);
    let domParent = f.pane;
    for (let index = 0; index < 3; index++) {
        const element = f.dom.window.document.createElement('div'); domParent.append(element); domParent = element;
        const child = { tag: 5, stateNode: element, memoizedProps: { children: null } };
        attach(rendered, child); rendered = child;
    }
    for (const [tag, props] of [[15, { entry: {}, sessionRef: f.view.sessionRef, isStreaming: false }],
        [0, { children: null }], [11, { children: null }]]) {
        const child = { tag, memoizedProps: props };
        attach(rendered, child); rendered = child;
    }
    const bubble = f.dom.window.document.createElement('div');
    bubble.setAttribute('data-cds-bubble-stack', ''); domParent.append(bubble);
    const bubbleFiber = { tag: 5, stateNode: bubble, memoizedProps: { 'data-cds-bubble-stack': '', children: null } };
    bubble.__reactFiber$fixture = bubbleFiber; attach(rendered, bubbleFiber);
    const items = f.dom.window.document.createElement('div');
    items.setAttribute('data-cds-bubble-stack-items', ''); bubble.append(items);
    const itemsFiber = { tag: 5, stateNode: items, memoizedProps: { 'data-cds-bubble-stack-items': '', children: null } };
    attach(bubbleFiber, itemsFiber);
    function grow(size) {
        attach(itemsFiber, ...Array.from({ length: size }, () => ({ tag: 0, memoizedProps: {} })));
    }
    grow(count);
    return { controller, detail, bubble, bubbleFiber, itemsFiber, grow };
}

test('long message presentation cannot exhaust the selected detail control lookup or later polls', t => {
    for (const remote of [false, true]) {
        const f = fixture(t, { remote });
        f.pane.dataset.sessionStatsKey = 'ss_long_chat';
        const body = presentationFixture(f);
        const reader = bindings();
        const expected = [{ key: 'ss_long_chat', bound: { sessionId: f.sessionId, agentId: 'agent_A-1', remote } }];
        assert.deepEqual(reader.readBindings(f.dom.window), expected);
        body.grow(3101);
        for (let poll = 0; poll < 3; poll++) assert.deepEqual(reader.readBindings(f.dom.window), expected);
    }
});

test('long message bodies do not hide conflicting control views or matching details outside their boundary', t => {
    const f = fixture(t);
    const body = presentationFixture(f, 3101);
    const rendered = body.detail.sibling;
    for (const conflicting of [
        { ...f.detail, paneView: { agentId: 'other' }, task: undefined },
        { ...f.view, view: { kind: 'subagent', toolUseId: 'toolu_other' } },
        { ...f.view, view: { kind: 'tasks' } },
    ]) {
        attach(body.controller, body.detail, rendered, { tag: 0, memoizedProps: conflicting });
        assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
    }
});

test('a message-render boundary requires its actual current host in the same pane', t => {
    for (const mismatch of ['props', 'dom', 'current', 'other-pane', 'other-root', 'duplicate-key']) {
        const f = fixture(t);
        const body = presentationFixture(f, 3101);
        if (mismatch === 'props') delete body.bubbleFiber.memoizedProps['data-cds-bubble-stack'];
        if (mismatch === 'dom') body.bubble.removeAttribute('data-cds-bubble-stack');
        if (mismatch === 'current') body.bubble.__reactFiber$fixture = {
            tag: 5, stateNode: body.bubble, return: { tag: 3, stateNode: f.root.stateNode },
        };
        if (mismatch === 'other-pane') {
            const other = f.dom.window.document.createElement('section'); other.dataset.paneRoot = '';
            f.dom.window.document.body.append(other); other.append(body.bubble);
        }
        if (mismatch === 'other-root') {
            const otherRoot = { tag: 3, stateNode: {} }; otherRoot.stateNode.current = otherRoot;
            body.bubbleFiber.return = otherRoot;
        }
        if (mismatch === 'duplicate-key') body.bubble.__reactFiber$other = body.bubbleFiber;
        assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null, mismatch);
    }
});

test('native AssistantMessage hosts remain presentation boundaries when the optional bubble marker is absent', t => {
    const f = fixture(t);
    const body = presentationFixture(f, 3101);
    body.bubble.removeAttribute('data-cds-bubble-stack');
    body.bubbleFiber.memoizedProps['data-cds-bubble-stack'] = undefined;
    body.bubble.dataset.cds = 'AssistantMessage';
    body.bubbleFiber.memoizedProps['data-cds'] = 'AssistantMessage';
    assert.deepEqual(bindings().resolveSubagent(f.pane, f.dom.window),
        { sessionId: LOCAL, agentId: 'agent_A-1', remote: false });
    body.bubble.dataset.cds = 'Unrelated';
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
    body.bubble.dataset.cds = 'AssistantMessage';
    body.bubbleFiber.memoizedProps['data-cds'] = 'Unrelated';
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
});

test('bailout shared message children stay bound across committed pane and DOM pointer alternate flips', t => {
    for (const remote of [false, true]) {
        const f = fixture(t, { remote });
        f.pane.dataset.sessionStatsKey = 'ss_bailout';
        const body = presentationFixture(f, 3101);
        body.bubble.removeAttribute('data-cds-bubble-stack');
        body.bubbleFiber.memoizedProps['data-cds-bubble-stack'] = undefined;
        body.bubble.dataset.cds = 'AssistantMessage';
        body.bubbleFiber.memoizedProps['data-cds'] = 'AssistantMessage';
        const alternateRoot = { tag: 3, stateNode: f.root.stateNode };
        const alternatePane = { tag: 5, stateNode: f.pane, memoizedProps: {},
            child: f.host.child, return: alternateRoot, alternate: f.host };
        alternateRoot.child = alternatePane; f.host.alternate = alternatePane;
        const alternateBubble = { tag: 5, stateNode: body.bubble, return: alternatePane,
            memoizedProps: body.bubbleFiber.memoizedProps, alternate: body.bubbleFiber };
        body.bubbleFiber.alternate = alternateBubble;
        const expected = [{ key: 'ss_bailout', bound: { sessionId: f.sessionId, agentId: 'agent_A-1', remote } }];
        for (let flip = 0; flip < 6; flip++) {
            f.root.stateNode.current = flip % 2 ? alternateRoot : f.root;
            f.pane.__reactFiber$fixture = flip % 2 ? f.host : alternatePane;
            body.bubble.__reactFiber$fixture = flip % 2 ? body.bubbleFiber : alternateBubble;
            assert.deepEqual(bindings().readBindings(f.dom.window), expected, `flip ${flip}`);
        }
    }
});

test('alternate host membership never borrows another DOM host or a different React root', t => {
    for (const mismatch of ['other-dom', 'unpaired-host', 'other-root']) {
        const f = fixture(t);
        const body = presentationFixture(f, 3101);
        const alternate = { tag: 5, stateNode: body.bubble, return: f.host, alternate: body.bubbleFiber };
        body.bubbleFiber.alternate = alternate; body.bubble.__reactFiber$fixture = alternate;
        if (mismatch === 'other-dom') alternate.stateNode = f.dom.window.document.createElement('div');
        if (mismatch === 'unpaired-host') alternate.alternate = {};
        if (mismatch === 'other-root') {
            const foreignRoot = { tag: 3, stateNode: {} }; foreignRoot.stateNode.current = foreignRoot;
            const alternatePane = { tag: 5, stateNode: f.pane, return: foreignRoot, alternate: f.host };
            f.host.alternate = alternatePane; f.host.child.return = alternatePane;
        }
        assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null, mismatch);
    }
});

test('message presentation props cannot supply or contradict pane controls', t => {
    const f = fixture(t);
    const body = presentationFixture(f, 3);
    attach(body.itemsFiber, { tag: 0, memoizedProps: { ...f.detail, paneView: { agentId: 'body-only' }, task: undefined } },
        { tag: 0, memoizedProps: { ...f.view, view: { kind: 'tasks' } } });
    assert.deepEqual(bindings().resolveSubagent(f.pane, f.dom.window),
        { sessionId: LOCAL, agentId: 'agent_A-1', remote: false });
    attach(body.controller, body.detail.sibling);
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
});

test('message boundary own props still participate in control conflict checks', t => {
    const f = fixture(t);
    const body = presentationFixture(f, 3101);
    Object.assign(body.bubbleFiber.memoizedProps, { ...f.view, view: { kind: 'tasks' } });
    assert.equal(bindings().resolveSubagent(f.pane, f.dom.window), null);
});

test('serialized lookup accepts the current message host alternate without reading stale or pending props', t => {
    const f = fixture(t);
    f.pane.dataset.sessionStatsKey = 'ss_long_chat';
    const body = presentationFixture(f, 3101);
    const stale = { tag: 5, stateNode: body.bubble, memoizedProps: {},
        return: { tag: 3, stateNode: f.root.stateNode }, alternate: body.bubbleFiber };
    body.bubbleFiber.alternate = stale;
    body.bubbleFiber.pendingProps = {};
    body.bubble.__reactFiber$fixture = stale;
    const { createSubagentBindings } = require('../src/subagent-binding.cjs');
    const reader = vm.runInNewContext(`(${createSubagentBindings.toString()})()`, { window: f.dom.window });
    assert.deepEqual(JSON.parse(JSON.stringify(reader.readBindings())), [{ key: 'ss_long_chat',
        bound: { sessionId: LOCAL, agentId: 'agent_A-1', remote: false } }]);
});

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
