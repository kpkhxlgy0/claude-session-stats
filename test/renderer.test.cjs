'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { parseSessionId, findComposer, startRenderer } = require('../src/renderer.cjs');
const ID = 'local_11111111-1111-4111-8111-111111111111';
const OTHER = 'local_22222222-2222-4222-8222-222222222222';
const REMOTE = 'session_Abc123-remote_01';
const stats = { status: 'ok', turns: 2, steps: 33, tps: null, totalTokens: 11700000,
    inputTokens: 11000000, outputTokens: 700000, cachedInputTokens: 10560000, cacheHit: 0.96 };
function fixture(t, url = `https://claude.ai/epitaxy/${ID}`) {
    const dom = new JSDOM('<main><form><div class="ProseMirror" contenteditable="true"></div>'
        + '<button type="submit">Send</button></form></main>', { url });
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    const rect = { x: 20, y: 500, left: 20, right: 620, top: 500, bottom: 600, width: 600, height: 100 };
    for (const node of doc.querySelectorAll('form, .ProseMirror, button')) {
        node.getClientRects = () => [rect]; node.getBoundingClientRect = () => rect;
    }
    const calls = [];
    const api = { log: { info() {} }, ipc: { invoke: async (channel, id) => {
        assert.equal(channel, 'stats'); calls.push(id); return { ...stats, threadId: id };
    } } };
    const run = () => {
        const controller = startRenderer(api, { window: dom.window, debounceMs: 0, pollMs: 30 });
        t.after(() => controller.stop()); return controller;
    };
    return { dom, doc, api, calls, run };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 70));
test('only trusted local and Remote Control candidate routes produce identities', () => {
    for (const origin of ['https://claude.ai', 'app://localhost']) {
        assert.equal(parseSessionId(`${origin}/epitaxy/${ID}`), ID);
        for (const path of ['epitaxy', 'code']) {
            assert.equal(parseSessionId(`${origin}/${path}/${REMOTE}`), REMOTE);
            assert.equal(parseSessionId(`${origin}/${path}/session_${'a'.repeat(128)}/`), `session_${'a'.repeat(128)}`);
        }
    }
    for (const url of [`https://evil.example/epitaxy/${ID}`, 'https://claude.ai/new',
        `https://claude.ai/chat/${ID}`, `https://claude.ai/epitaxy/${ID}/extra`,
        `https://claude.ai/code/${ID}`, `https://claude.ai/chat/${REMOTE}`,
        `https://claude.ai/code/${REMOTE}/extra`, 'https://claude.ai/epitaxy/session_',
        `https://claude.ai/epitaxy/session_${'a'.repeat(129)}`, 'https://claude.ai/epitaxy/session_a%2fb',
        `app://user@localhost/epitaxy/${REMOTE}`, `app://localhost:1234/code/${REMOTE}`,
        `https://user:pass@claude.ai/code/${REMOTE}`, `app://claude.ai/code/${REMOTE}`,
        'https://claude.ai/epitaxy/local_..%2fsecret']) assert.equal(parseSessionId(url), null);
});
test('semantic composer detection requires a unique visible editor and excludes dialogs', t => {
    const f = fixture(t);
    assert.equal(findComposer(f.dom.window), f.doc.querySelector('form'));
    const other = f.doc.querySelector('form').cloneNode(true);
    f.doc.body.append(other);
    const editor = other.querySelector('.ProseMirror');
    editor.getClientRects = () => [{width: 600, height: 100}];
    assert.equal(findComposer(f.dom.window), null);
    other.setAttribute('role', 'dialog');
    assert.equal(findComposer(f.dom.window), f.doc.querySelector('form'));
});
test('shows five stats, missing TPS and no context, without changing composer layout', async t => {
    const f = fixture(t); const before = f.doc.querySelector('form').outerHTML;
    const c = f.run(); await tick();
    const bar = f.doc.querySelector('[data-session-stats]');
    assert.match(bar.textContent, /2 turns.*33 steps.*— tok\/s.*11\.7M tok.*Cache hit 96%/);
    assert.match(f.doc.querySelector('[data-stat="tps"]').title, /整个会话.*有效响应样本/);
    assert.match(f.doc.querySelector('[data-stat="tps"]').title, /首 Token 等待/);
    assert.doesNotMatch(bar.textContent, /context|上下文/i);
    assert.equal(f.dom.window.getComputedStyle(bar).position, 'fixed');
    assert.equal(f.doc.querySelector('form').outerHTML, before);
    c.stop(); c.stop();
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
    assert.equal(f.doc.querySelector('[data-session-stats-style]'), null);
});
test('uses the empty center of the lower controls row instead of the input border', async t => {
    const f = fixture(t);
    const form = f.doc.querySelector('form');
    const wrapper = f.doc.createElement('section');
    form.replaceWith(wrapper); wrapper.append(form);
    const controls = f.doc.createElement('div');
    controls.innerHTML = '<button>Bypass permissions</button><button>Model</button>';
    wrapper.append(controls);
    const bounds = (node, left, top, width, height) => {
        const rect = { left, top, right: left + width, bottom: top + height, width, height };
        node.getClientRects = () => [rect]; node.getBoundingClientRect = () => rect;
    };
    bounds(wrapper, 20, 500, 600, 140);
    bounds(controls.children[0], 22, 612, 100, 24);
    bounds(controls.children[1], 500, 612, 115, 24);
    const before = wrapper.outerHTML;
    f.run(); await tick();
    const bar = f.doc.querySelector('[data-session-stats]');
    assert.equal(parseFloat(bar.style.top), 617);
    assert.equal(parseFloat(bar.style.left) + parseFloat(bar.style.width) / 2, 320);
    assert.ok(parseFloat(bar.style.left) > 122);
    assert.ok(parseFloat(bar.style.left) + parseFloat(bar.style.width) < 500);
    assert.equal(wrapper.outerHTML, before);
});

test('marks numeric TPS as an estimate', async t => {
    const f = fixture(t);
    f.api.ipc.invoke = async (_, id) => ({ ...stats, threadId: id, tps: 41.7 });
    f.run(); await tick();
    assert.equal(f.doc.querySelector('[data-stat="tps"]').textContent, '≈ 42 tok/s');
});
test('late previous-session reply cannot overwrite selected conversation', async t => {
    const f = fixture(t); let resolveFirst;
    f.api.ipc.invoke = async (_, id) => id === ID ? new Promise(resolve => { resolveFirst = resolve; })
        : { ...stats, threadId: id, turns: 7 };
    f.run(); await tick();
    f.dom.window.history.pushState({}, '', `/epitaxy/${OTHER}`); await tick();
    resolveFirst({ ...stats, threadId: ID }); await tick();
    assert.match(f.doc.querySelector('[data-session-stats]').textContent, /7 turns/);
});
test('removes footer on home, hidden composer, or removed editor', async t => {
    const f = fixture(t); f.run(); await tick();
    f.doc.querySelector('form').hidden = true; await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
    f.doc.querySelector('form').hidden = false; await tick();
    assert.ok(f.doc.querySelector('[data-session-stats]'));
    f.dom.window.history.pushState({}, '', '/new'); await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
});
test('unavailable or mismatched results never show usable metrics', async t => {
    const f = fixture(t);
    f.api.ipc.invoke = async () => ({ ...stats, threadId: OTHER });
    f.run(); await tick();
    assert.match(f.doc.querySelector('[data-session-stats]').textContent, /— turns.*— steps.*— tok\/s/);
});

test('Remote Control candidates wait for confirmed stats without overlapping requests', async t => {
    const f = fixture(t, `https://claude.ai/code/${REMOTE}`);
    let resolveStats;
    const calls = [];
    f.api.ipc.invoke = (...args) => {
        calls.push(args);
        return new Promise(resolve => { resolveStats = resolve; });
    };
    const before = f.doc.querySelector('form').outerHTML;
    f.run(); await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
    assert.deepEqual(calls, [['remote-stats']]);
    resolveStats({ ...stats, threadId: REMOTE, source: 'remote_control', tps: 41.7 });
    await new Promise(resolve => setTimeout(resolve, 0));
    const bar = f.doc.querySelector('[data-session-stats]');
    assert.match(bar.textContent, /2 turns.*33 steps.*≈ 42 tok\/s.*11\.7M tok.*Cache hit 96%/);
    assert.doesNotMatch(bar.textContent, /context|上下文/i);
    assert.match(f.doc.querySelector('[data-stat="tokens"]').title, /运行端.*会话日志/);
    assert.doesNotMatch(bar.title, /本地/);
    assert.equal(f.doc.querySelector('form').outerHTML, before);
    assert.equal(parseFloat(bar.style.left) + parseFloat(bar.style.width) / 2, 320);
});

test('Remote Control can show valid metrics when TPS is unavailable', async t => {
    const f = fixture(t, `app://localhost/epitaxy/${REMOTE}`);
    f.api.ipc.invoke = async (...args) => {
        assert.deepEqual(args, ['remote-stats']);
        return { ...stats, threadId: REMOTE, source: 'remote_control' };
    };
    f.run(); await tick();
    assert.match(f.doc.querySelector('[data-session-stats]').textContent, /2 turns.*33 steps.*— tok\/s/);
});

test('remote missing or expired snapshots show an explanation without stale numbers', async t => {
    const f = fixture(t, `https://claude.ai/code/${REMOTE}`);
    let result = { ...stats, threadId: REMOTE, source: 'remote_control', tps: 42 };
    f.api.ipc.invoke = async () => result;
    f.run(); await tick();
    assert.match(f.doc.querySelector('[data-session-stats]').textContent, /42 tok\/s/);
    result = { ...result, status: 'unavailable', unavailableReason: 'snapshot-expired' };
    await tick();
    const bar = f.doc.querySelector('[data-session-stats]');
    assert.ok(bar);
    assert.match(bar.textContent, /— tok\/s/);
    assert.doesNotMatch(bar.textContent, /42 tok\/s|33 steps/);
    assert.match(bar.title, /快照.*过期/);
    result = { ...result, unavailableReason: 'snapshot-missing' };
    await tick();
    assert.match(bar.title, /运行端.*Session Stats/);
});

test('remote TPS tooltip describes the runner log rather than synchronized event timing', async t => {
    const f = fixture(t, `https://claude.ai/code/${REMOTE}`);
    f.api.ipc.invoke = async () => ({ ...stats, threadId: REMOTE, source: 'remote_control' });
    f.run(); await tick();
    assert.match(f.doc.querySelector('[data-stat="tps"]').title, /运行端.*快照/);
    assert.doesNotMatch(f.doc.querySelector('[data-stat="tokens"]').title, /仅包含 Remote Control 同步历史/);
});

test('unconfirmed cloud, stale identity, and incomplete remote results stay hidden while polling', async t => {
    for (const [label, response] of [
        ['unknown', null],
        ['cloud', { ...stats, threadId: REMOTE, source: 'cloud' }],
        ['stale identity', { ...stats, threadId: 'session_another', source: 'remote_control' }],
        ['incomplete', { ...stats, threadId: REMOTE, source: 'remote_control', status: 'incomplete' }],
    ]) await t.test(label, async t => {
        const f = fixture(t, `https://claude.ai/code/${REMOTE}`);
        let calls = 0;
        f.api.ipc.invoke = async () => { calls++; return response; };
        f.run(); await tick();
        assert.equal(f.doc.querySelector('[data-session-stats]'), null);
        assert.ok(calls > 1);
    });
});

test('Remote Control footer is removed when the bridge later reports cloud or unknown', async t => {
    for (const [label, response] of [['unknown', null], ['cloud', { ...stats, threadId: REMOTE, source: 'cloud' }]])
        await t.test(label, async t => {
            const f = fixture(t, `https://claude.ai/code/${REMOTE}`);
            let result = { ...stats, threadId: REMOTE, source: 'remote_control' };
            f.api.ipc.invoke = async () => result;
            f.run(); await tick();
            assert.ok(f.doc.querySelector('[data-session-stats]'));
            result = response; await tick();
            assert.equal(f.doc.querySelector('[data-session-stats]'), null);
        });
});

test('remote to local to remote navigation rejects the old pending reply', async t => {
    const f = fixture(t, `https://claude.ai/code/${REMOTE}`);
    let resolveFirst;
    let resolveSecond;
    let remoteCalls = 0;
    f.api.ipc.invoke = async (...args) => {
        if (args[0] === 'stats') {
            assert.deepEqual(args, ['stats', ID]);
            return { ...stats, threadId: ID, turns: 7 };
        }
        assert.deepEqual(args, ['remote-stats']);
        remoteCalls++;
        return remoteCalls === 1 ? new Promise(resolve => { resolveFirst = resolve; })
            : new Promise(resolve => { resolveSecond = resolve; });
    };
    f.run(); await tick();
    f.dom.window.history.pushState({}, '', `/epitaxy/${ID}`); await tick();
    assert.match(f.doc.querySelector('[data-session-stats]').textContent, /7 turns/);
    f.dom.window.history.pushState({}, '', `/code/${REMOTE}`); await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
    assert.equal(remoteCalls, 1);
    resolveFirst({ ...stats, threadId: REMOTE, source: 'remote_control' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
    await tick();
    resolveSecond({ ...stats, threadId: REMOTE, source: 'remote_control', turns: 9 });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(f.doc.querySelector('[data-session-stats]').textContent, /9 turns/);
});

test('replaced composer rejects the old pending Remote Control reply', async t => {
    const f = fixture(t, `https://claude.ai/code/${REMOTE}`);
    const pending = [];
    f.api.ipc.invoke = () => new Promise(resolve => { pending.push(resolve); });
    f.run(); await tick();
    const form = f.doc.querySelector('form');
    const replacement = form.cloneNode(true);
    const rect = form.getBoundingClientRect();
    for (const node of [replacement, ...replacement.querySelectorAll('.ProseMirror, button')]) {
        node.getClientRects = () => [rect]; node.getBoundingClientRect = () => rect;
    }
    form.replaceWith(replacement); await tick();
    assert.equal(pending.length, 2);
    pending[0]({ ...stats, threadId: REMOTE, source: 'remote_control' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
    pending[1]({ ...stats, threadId: REMOTE, source: 'remote_control', turns: 8 });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(f.doc.querySelector('[data-session-stats]').textContent, /8 turns/);
});

test('stopped Remote Control renderer ignores later fulfilled or rejected requests', async t => {
    for (const outcome of ['resolve', 'reject']) await t.test(outcome, async t => {
        const f = fixture(t, `https://claude.ai/code/${REMOTE}`);
        let settle;
        f.api.ipc.invoke = () => new Promise((resolve, reject) => {
            settle = outcome === 'resolve'
                ? () => resolve({ ...stats, threadId: REMOTE, source: 'remote_control' })
                : () => reject(new Error('window closed'));
        });
        const controller = f.run(); await tick();
        controller.stop(); settle(); await tick();
        assert.equal(f.doc.querySelector('[data-session-stats]'), null);
        assert.equal(f.doc.querySelector('[data-session-stats-style]'), null);
    });
});
