'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { createSubagentBindings } = require('../src/subagent-binding.cjs');
const { findComposer, startRenderer } = require('../src/renderer.cjs');
const LOCAL = 'local_11111111-1111-4111-8111-111111111111';
const REMOTE = 'session_Abc123-remote_01';
const tick = () => new Promise(resolve => setTimeout(resolve, 75));
const sample = { status: 'ok', turns: 1, steps: 5, tps: null, totalTokens: 1200,
    inputTokens: 1000, outputTokens: 200, cachedInputTokens: 800, cacheHit: .8 };

function fixture(t, { remote = false, parent = false, childEditor = false } = {}) {
    const sessionId = remote ? REMOTE : LOCAL;
    const dom = new JSDOM('<main></main>',
        { url: `https://claude.ai/${remote ? 'code' : 'epitaxy'}/${sessionId}` });
    t.after(() => dom.window.close());
    const doc = dom.window.document, calls = [], bindings = createSubagentBindings();
    const hostStyle = doc.createElement('style');
    hostStyle.textContent = '.task-pane { padding-bottom: 0; box-sizing: content-box; }';
    doc.head.append(hostStyle);
    function bounds(node) {
        const rect = { left: 20, top: 200, right: 620, bottom: 600, width: 600, height: 400 };
        node.getClientRects = () => [rect]; node.getBoundingClientRect = () => rect;
    }
    function addComposer(container) {
        const form = doc.createElement('form');
        form.innerHTML = '<div class="ProseMirror" contenteditable="true"></div><button>Send</button>';
        container.append(form);
        for (const node of [form, ...form.children]) bounds(node);
        return form;
    }
    const parentForm = parent ? addComposer(doc.querySelector('main')) : null;
    function pane(agentId = 'agent_A-1') {
        const root = doc.createElement('section');
        root.dataset.paneRoot = ''; root.dataset.perfScreen = 'tasks'; root.style.position = 'relative';
        root.className = 'task-pane';
        root.style.display = 'flex'; root.style.flexDirection = 'column'; root.style.height = '400px';
        root.innerHTML = '<header style="height:45px;flex-shrink:0">Task</header>'
            + '<div class="content" style="flex:1;min-height:0;overflow:hidden">'
            + '<div class="transcript" style="height:100%;overflow:auto">Selected subagent</div></div>';
        doc.querySelector('main').append(root); bounds(root);
        if (childEditor) addComposer(root.querySelector('.content'));
        const host = { tag: 5, stateNode: root, memoizedProps: {} };
        const fiberRoot = { tag: 3, stateNode: {}, child: host }; fiberRoot.stateNode.current = fiberRoot;
        host.return = fiberRoot; root.__reactFiber$fixture = host;
        const ref = { type: remote ? 'bridge' : 'local', id: sessionId };
        function select(id = agentId, toolUseId = `toolu_${id}`) {
            const view = { tag: 0, return: host,
                memoizedProps: { view: { kind: id ? 'subagent' : 'tasks', toolUseId }, sessionRef: ref } };
            const detail = { tag: 0, return: host, memoizedProps: { openedToolUseId: toolUseId,
                sessionRef: ref, paneView: { agentId: id }, task: { taskId: id, toolUseId } } };
            view.sibling = detail; host.child = view;
            root.querySelector('.transcript').textContent = id || 'Task list';
        }
        select();
        return { root, select };
    }
    const selected = pane();
    let reply = payload => ({ ...sample, threadId: payload.sessionId, agentId: payload.agentId,
        ...(remote ? { source: 'remote_control' } : {}) });
    const api = { ipc: { invoke: async (channel, payload) => {
        calls.push([channel, payload]);
        if (channel === 'agent-bindings') return bindings.readBindings(dom.window);
        if (channel === 'agent-stats') return reply(payload);
        if (channel === 'remote-agent-stats') {
            const match = bindings.readBindings(dom.window).find(row => row.key === payload.key);
            return match ? reply(match.bound) : null;
        }
        if (channel === 'stats') return { ...sample, threadId: payload, turns: 9 };
        if (channel === 'remote-stats') return { ...sample, threadId: sessionId, source: 'remote_control', turns: 9 };
        assert.fail(`Unexpected IPC ${channel}`);
    } } };
    const run = () => {
        const controller = startRenderer(api, { window: dom.window, debounceMs: 0, pollMs: 25 });
        t.after(() => controller.stop()); return controller;
    };
    return { dom, doc, calls, api, sessionId, parentForm, selected, pane, run,
        setReply(value) { reply = value; } };
}

test('local selected child reserves a fixed footer below its flex transcript without a composer', async t => {
    const f = fixture(t); const before = f.selected.root.style.cssText;
    f.run(); await tick();
    const bar = f.selected.root.querySelector('[data-session-stats-agent]');
    assert.ok(bar);
    assert.equal(bar.parentElement, f.selected.root);
    assert.match(bar.textContent, /1 turns.*5 steps.*— tok\/s.*1\.2K tok.*Cache hit 80%/);
    assert.doesNotMatch(bar.textContent, /context|上下文/i);
    const style = f.dom.window.getComputedStyle(bar);
    assert.equal(style.position, 'absolute');
    assert.equal(style.bottom, '2px');
    assert.equal(style.left, '16px'); assert.equal(style.right, '16px');
    assert.equal(style.margin, '0px'); assert.equal(style.padding, '0px');
    assert.equal(f.selected.root.style.cssText, before);
    assert.equal(f.dom.window.getComputedStyle(f.selected.root).paddingBottom, '24px');
    assert.equal(f.dom.window.getComputedStyle(f.selected.root).boxSizing, 'border-box');
    assert.equal(f.dom.window.getComputedStyle(f.selected.root.querySelector('.content')).flex, '1 1 0%');
    assert.equal(f.dom.window.getComputedStyle(bar.firstChild).marginLeft, 'auto');
    assert.equal(f.dom.window.getComputedStyle(bar.lastChild).marginRight, 'auto');
    assert.deepEqual(f.calls.find(call => call[0] === 'agent-stats'),
        ['agent-stats', { sessionId: LOCAL, agentId: 'agent_A-1' }]);
});

test('child editors do not hide the parent composer statistics or create a second composer footer', async t => {
    const f = fixture(t, { parent: true, childEditor: true });
    assert.equal(findComposer(f.dom.window), f.parentForm);
    const before = f.parentForm.outerHTML;
    f.run(); await tick();
    assert.equal(f.doc.querySelectorAll('[data-session-stats]').length, 2);
    assert.match(f.doc.body.querySelector('[data-session-stats]:not([data-session-stats-agent])').textContent, /9 turns/);
    assert.match(f.selected.root.querySelector('[data-session-stats-agent]').textContent, /1 turns/);
    assert.equal(f.parentForm.outerHTML, before);
    assert.equal(f.parentForm.hasAttribute('data-session-stats-footer'), false);
    assert.equal(f.parentForm.parentElement.hasAttribute('data-session-stats-footer'), false);
});

test('remote child metrics require matching session, exact agent and Remote Control source', async t => {
    const f = fixture(t, { remote: true });
    f.run(); await tick();
    const key = f.selected.root.dataset.sessionStatsKey;
    assert.match(key, /^[A-Za-z0-9_-]{1,128}$/);
    assert.deepEqual(f.calls.find(call => call[0] === 'remote-agent-stats'), ['remote-agent-stats', { key }]);
    assert.match(f.selected.root.querySelector('[data-session-stats-agent]').textContent, /5 steps.*— tok\/s/);
    for (const change of [{ agentId: 'other' }, { threadId: 'session_other' }, { source: 'cloud' }]) {
        f.setReply(payload => ({ ...sample, threadId: payload.sessionId, agentId: payload.agentId,
            source: 'remote_control', ...change }));
        await tick();
        assert.equal(f.selected.root.querySelector('[data-session-stats-agent]'), null);
        assert.equal(f.dom.window.getComputedStyle(f.selected.root).paddingBottom, '0px');
    }
    f.setReply(() => Promise.reject(new Error('Disconnected'))); await tick();
    assert.equal(f.selected.root.hasAttribute('data-session-stats-footer'), false);
    f.setReply(payload => ({ status: 'unavailable', threadId: payload.sessionId, agentId: payload.agentId,
        source: 'remote_control', unavailableReason: 'snapshot-missing' }));
    await tick();
    const bar = f.selected.root.querySelector('[data-session-stats-agent]');
    assert.match(bar.textContent, /— turns.*— steps.*— tok\/s/);
    assert.match(bar.title, /Session Stats/);
    assert.equal(f.dom.window.getComputedStyle(f.selected.root).paddingBottom, '24px');
});

test('multiple child panes keep independent identities and metric bars', async t => {
    const f = fixture(t); const other = f.pane('agent_B');
    f.setReply(payload => ({ ...sample, threadId: payload.sessionId, agentId: payload.agentId,
        steps: payload.agentId === 'agent_B' ? 8 : 5 }));
    f.run(); await tick();
    assert.match(f.selected.root.querySelector('[data-session-stats-agent]').textContent, /5 steps/);
    assert.match(other.root.querySelector('[data-session-stats-agent]').textContent, /8 steps/);
    assert.notEqual(f.selected.root.dataset.sessionStatsKey, other.root.dataset.sessionStatsKey);
});

test('resuming the selected child keeps its mounted footer when task metadata moves to a new call', async t => {
    for (const remote of [false, true]) await t.test(remote ? 'remote' : 'local', async t => {
        const f = fixture(t, { remote }); f.run(); await tick();
        const bar = f.selected.root.querySelector('[data-session-stats-agent]');
        assert.match(bar.textContent, /5 steps/);
        const view = f.selected.root.__reactFiber$fixture.child;
        const props = view.sibling.memoizedProps;
        props.paneView = { ...props.paneView, callId: view.memoizedProps.view.toolUseId, isResumed: true };
        props.task = { ...props.task, toolUseId: 'toolu_new_resume_call' };
        f.setReply(payload => ({ ...sample, threadId: payload.sessionId, agentId: payload.agentId,
            steps: 8, ...(remote ? { source: 'remote_control' } : {}) }));
        f.selected.root.querySelector('.transcript').textContent = 'Resumed task';
        for (let pass = 0; pass < 3; pass++) {
            await tick();
            assert.equal(f.selected.root.querySelector('[data-session-stats-agent]'), bar);
            assert.match(bar.textContent, /8 steps/);
            assert.equal(f.dom.window.getComputedStyle(f.selected.root).paddingBottom, '24px');
        }
    });
});

test('local and remote child bars survive long transcript growth and recover after a conflicting binding clears', async t => {
    for (const remote of [false, true]) await t.test(remote ? 'remote' : 'local', async t => {
        const f = fixture(t, { remote });
        f.run(); await tick();
        const firstBar = f.selected.root.querySelector('[data-session-stats-agent]');
        assert.ok(firstBar);
        const host = f.selected.root.__reactFiber$fixture;
        const detail = host.child.sibling;
        const bubble = f.doc.createElement('div'); bubble.dataset.cdsBubbleStack = '';
        f.selected.root.querySelector('.transcript').append(bubble);
        const presentation = { tag: 5, stateNode: bubble, return: host,
            memoizedProps: { 'data-cds-bubble-stack': '' } };
        bubble.__reactFiber$fixture = presentation;
        detail.sibling = presentation;
        let previous = presentation;
        for (let index = 0; index < 3101; index++) {
            const child = { tag: 0, return: previous, memoizedProps: {} };
            previous.child = child; previous = child;
        }
        for (let pass = 0; pass < 3; pass++) {
            await tick();
            assert.equal(f.selected.root.querySelector('[data-session-stats-agent]'), firstBar);
            assert.match(firstBar.textContent, /1 turns.*5 steps/);
        }
        presentation.sibling = { tag: 0, return: host, memoizedProps: {
            ...detail.memoizedProps, paneView: { agentId: 'conflicting_agent' },
            task: { taskId: 'conflicting_agent', toolUseId: detail.memoizedProps.openedToolUseId },
        } };
        await tick();
        assert.equal(f.selected.root.querySelector('[data-session-stats-agent]'), null);
        presentation.sibling = null;
        await tick();
        assert.match(f.selected.root.querySelector('[data-session-stats-agent]').textContent, /1 turns.*5 steps/);
    });
});

test('selection switches, task lists, hidden panes and remounts remove obsolete child bars', async t => {
    const f = fixture(t); const pending = [];
    f.doc.querySelector('style').textContent = '.task-pane { padding-bottom: 6px; box-sizing: content-box; }';
    f.setReply(payload => new Promise(resolve => pending.push({ payload, resolve })));
    f.run(); await tick();
    assert.equal(pending[0].payload.agentId, 'agent_A-1');
    f.selected.select('agent_B'); await tick();
    assert.equal(pending[1].payload.agentId, 'agent_B');
    pending[0].resolve({ ...sample, threadId: LOCAL, agentId: 'agent_A-1', steps: 99 });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.doesNotMatch(f.selected.root.querySelector('[data-session-stats-agent]').textContent, /99 steps/);
    pending[1].resolve({ ...sample, threadId: LOCAL, agentId: 'agent_B', steps: 8 }); await tick();
    assert.match(f.selected.root.querySelector('[data-session-stats-agent]').textContent, /8 steps/);
    f.selected.select(null); await tick();
    assert.equal(f.selected.root.querySelector('[data-session-stats-agent]'), null);
    assert.equal(f.selected.root.hasAttribute('data-session-stats-footer'), false);
    assert.equal(f.dom.window.getComputedStyle(f.selected.root).paddingBottom, '6px');
    assert.equal(f.dom.window.getComputedStyle(f.selected.root).boxSizing, 'content-box');
    f.selected.select('agent_C'); await tick();
    assert.ok(f.selected.root.querySelector('[data-session-stats-agent]'));
    assert.equal(f.dom.window.getComputedStyle(f.selected.root).paddingBottom, '24px');
    f.selected.root.hidden = true; await tick();
    assert.equal(f.selected.root.querySelector('[data-session-stats-agent]'), null);
    assert.equal(f.selected.root.hasAttribute('data-session-stats-key'), false);
    assert.equal(f.selected.root.hasAttribute('data-session-stats-footer'), false);
    f.selected.root.hidden = false; await tick();
    assert.equal(f.dom.window.getComputedStyle(f.selected.root).paddingBottom, '24px');
    f.selected.root.remove(); const replacement = f.pane('agent_D'); await tick();
    assert.equal(f.selected.root.hasAttribute('data-session-stats-footer'), false);
    assert.ok(replacement.root.querySelector('[data-session-stats-agent]'));
    assert.equal(f.doc.querySelectorAll('[data-session-stats-agent]').length, 1);
});

test('late binding replies cannot remount a closed or route-changed pane', async t => {
    const f = fixture(t); let settle;
    const invoke = f.api.ipc.invoke;
    f.api.ipc.invoke = (channel, payload) => channel === 'agent-bindings'
        ? new Promise(resolve => { settle = resolve; }) : invoke(channel, payload);
    f.run(); await tick();
    const key = f.selected.root.dataset.sessionStatsKey;
    f.dom.window.history.pushState({}, '', '/new');
    f.selected.root.remove();
    settle([{ key, bound: { sessionId: LOCAL, agentId: 'agent_A-1', remote: false } }]);
    await tick();
    assert.equal(f.doc.querySelector('[data-session-stats-agent]'), null);
    assert.equal(f.calls.some(call => call[0] === 'agent-stats'), false);
});

test('stopping removes child bars and keys and ignores pending metric replies', async t => {
    const f = fixture(t, { remote: true }); let settle;
    const controller = f.run(); await tick();
    assert.equal(f.dom.window.getComputedStyle(f.selected.root).paddingBottom, '24px');
    f.setReply(() => new Promise(resolve => { settle = resolve; }));
    await tick();
    const oldKey = f.selected.root.dataset.sessionStatsKey;
    controller.stop();
    assert.equal(f.selected.root.hasAttribute('data-session-stats-key'), false);
    assert.equal(f.selected.root.hasAttribute('data-session-stats-footer'), false);
    assert.equal(f.dom.window.getComputedStyle(f.selected.root).paddingBottom, '0px');
    assert.equal(f.dom.window.getComputedStyle(f.selected.root).boxSizing, 'content-box');
    settle({ ...sample, threadId: REMOTE, agentId: 'agent_A-1', source: 'remote_control' });
    await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
    assert.equal(f.doc.querySelector('[data-session-stats-style]'), null);
    f.setReply(payload => ({ ...sample, threadId: payload.sessionId, agentId: payload.agentId, source: 'remote_control' }));
    f.run(); await tick();
    assert.notEqual(f.selected.root.dataset.sessionStatsKey, oldKey);
    assert.ok(f.selected.root.querySelector('[data-session-stats-agent]'));
});

test('unrelated main transcript changes and viewport events do not discard a child metric reply', async t => {
    const f = fixture(t); let settle;
    const transcript = f.doc.createElement('div'); f.doc.querySelector('main').prepend(transcript);
    f.setReply(() => new Promise(resolve => { settle = resolve; }));
    f.run(); await tick();
    transcript.textContent = 'A new parent response';
    f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));
    f.dom.window.dispatchEvent(new f.dom.window.Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 0));
    settle({ ...sample, threadId: LOCAL, agentId: 'agent_A-1', steps: 17 });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(f.selected.root.querySelector('[data-session-stats-agent]').textContent, /17 steps/);
});

test('a streaming sibling pane cannot invalidate another child pending response', async t => {
    const f = fixture(t); const other = f.pane('agent_B'); const pending = new Map();
    f.setReply(payload => new Promise(resolve => pending.set(payload.agentId, resolve)));
    f.run(); await tick();
    f.selected.root.querySelector('.transcript').textContent = 'More output from A';
    await new Promise(resolve => setTimeout(resolve, 0));
    pending.get('agent_B')({ ...sample, threadId: LOCAL, agentId: 'agent_B', steps: 23 });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(other.root.querySelector('[data-session-stats-agent]').textContent, /23 steps/);
});
