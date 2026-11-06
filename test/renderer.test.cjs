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
        for (const path of ['epitaxy', 'code']) {
            assert.equal(parseSessionId(`${origin}/${path}/${ID}`), ID);
            assert.equal(parseSessionId(`${origin}/${path}/${ID}/`), ID);
            assert.equal(parseSessionId(`${origin}/${path}/${REMOTE}`), REMOTE);
            assert.equal(parseSessionId(`${origin}/${path}/session_${'a'.repeat(128)}/`), `session_${'a'.repeat(128)}`);
        }
    }
    for (const url of [`https://evil.example/epitaxy/${ID}`, 'https://claude.ai/new',
        `https://claude.ai/chat/${ID}`, `https://claude.ai/epitaxy/${ID}/extra`,
        `https://claude.ai/code/${ID}/extra`, `https://claude.ai/chat/${REMOTE}`,
        `https://claude.ai/code/${REMOTE}/extra`, 'https://claude.ai/epitaxy/session_',
        `https://claude.ai/epitaxy/session_${'a'.repeat(129)}`, 'https://claude.ai/epitaxy/session_a%2fb',
        `app://user@localhost/epitaxy/${REMOTE}`, `app://localhost:1234/code/${REMOTE}`,
        `https://user:pass@claude.ai/code/${REMOTE}`, `app://claude.ai/code/${REMOTE}`,
        'https://claude.ai/epitaxy/local_..%2fsecret']) assert.equal(parseSessionId(url), null);
    for (const path of ['epitaxy', 'code']) {
        for (const url of [`https://claude.ai.evil.example/${path}/${ID}`,
            `http://claude.ai/${path}/${ID}`, `https://claude.ai:444/${path}/${ID}`,
            `app://localhost.evil.example/${path}/${ID}`, `app://localhost:1234/${path}/${ID}`,
            `https://user:pass@claude.ai/${path}/${ID}`, `app://user@localhost/${path}/${ID}`,
            `https://claude.ai/${path}/%6cocal_${ID.slice(6)}`,
            `https://claude.ai/${path}/${ID.replace('1', '%31')}`,
            `https://claude.ai/${path}/${ID}%2fextra`, `https://claude.ai/${path}/${ID}/extra`,
            `https://claude.ai/${path}/local_11111111-1111-0111-8111-111111111111`]) {
            assert.equal(parseSessionId(url), null, url);
        }
    }
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
    assertStatsRow(bar, f.doc.querySelector('form'), f.dom.window);
    assert.equal(f.doc.querySelector('form').outerHTML, before);
    c.stop(); c.stop();
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
    assert.equal(f.doc.querySelector('[data-session-stats-style]'), null);
});

test('marks a local-only sample visibly and clears the notice on a shared sample', async t => {
    const f = fixture(t);
    f.api.ipc.invoke = async () => ({ ...stats, threadId: ID, snapshotSync: 'local-only' });
    f.run(); await tick();
    const bar = f.doc.querySelector('[data-session-stats]');
    assert.match(bar.textContent, /33 steps/);
    assert.match(bar.textContent, /仅本机/);
    assert.match(bar.title, /未同步/);
    f.api.ipc.invoke = async () => ({ ...stats, threadId: ID, snapshotGeneratedAt: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.doesNotMatch(bar.textContent, /仅本机/);
    assert.match(bar.title, /共享/);
});

test('replacing the composer for a new prompt preserves the same session bar while stats are pending', async t => {
    const f = fixture(t);
    f.run(); await tick();
    const bar = f.doc.querySelector('[data-session-stats]');
    assert.match(bar.textContent, /33 steps/);
    let settle;
    f.api.ipc.invoke = (_, id) => new Promise(resolve => { settle = () => resolve({ ...stats, threadId: id, steps: 34 }); });
    const old = f.doc.querySelector('form'), replacement = old.cloneNode(true);
    for (const node of [replacement, ...replacement.children]) {
        node.getClientRects = old.getClientRects; node.getBoundingClientRect = old.getBoundingClientRect;
    }
    old.replaceWith(replacement); await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), bar);
    assert.match(bar.textContent, /33 steps/);
    settle(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(bar.textContent, /34 steps/);
});

test('a short same-session composer gap keeps the bar but navigation clears it immediately', async t => {
    const f = fixture(t);
    f.run(); await tick();
    const bar = f.doc.querySelector('[data-session-stats]');
    const form = f.doc.querySelector('form'); form.remove(); await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), bar);
    assert.match(bar.textContent, /33 steps/);
    f.doc.querySelector('main').append(form); await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), bar);
    form.remove(); f.dom.window.history.pushState({}, '', `/epitaxy/${OTHER}`); await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
});

test('an absent composer cannot retain its old statistics indefinitely', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 10000 });
    const f = fixture(t);
    f.run(); await tick();
    f.doc.querySelector('form').remove(); await tick();
    assert.ok(f.doc.querySelector('[data-session-stats]'));
    t.mock.timers.tick(1500); await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
});

test('reusing composer A after A to B to A ignores the first A request and its cleanup', async t => {
    for (const outcome of ['resolve', 'reject']) await t.test(outcome, async t => {
        const f = fixture(t); f.run(); await tick();
        const bar = f.doc.querySelector('[data-session-stats]');
        const pending = [];
        f.api.ipc.invoke = (_, id) => new Promise((resolve, reject) => pending.push({ id, resolve, reject }));
        await tick();
        const a = f.doc.querySelector('form'), b = a.cloneNode(true);
        for (const node of [b, ...b.children]) {
            node.getClientRects = a.getClientRects; node.getBoundingClientRect = a.getBoundingClientRect;
        }
        a.replaceWith(b); await tick(); b.replaceWith(a); await tick();
        assert.equal(pending.length, 3);
        pending[2].resolve({ ...stats, threadId: ID, steps: 88 });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.match(bar.textContent, /88 steps/);
        if (outcome === 'resolve') pending[0].resolve({ ...stats, threadId: ID, steps: 11 });
        else pending[0].reject(new Error('Old composer request failed'));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.match(bar.textContent, /88 steps/);
    });
});
function lowerControlsFixture(t) {
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
    Object.defineProperty(f.dom.window, 'innerHeight', { value: 640, configurable: true });
    const layout = ({ left, width, buttons }) => {
        bounds(wrapper, left, 500, width, 140);
        for (const node of [form, ...form.children]) bounds(node, left, 500, width, 100);
        buttons.forEach(([buttonLeft, buttonWidth], i) => bounds(controls.children[i], buttonLeft, 612, buttonWidth, 24));
    };
    return { ...f, wrapper, controls, layout };
}

test('an anchored composer keeps the reserved row within its bottom-aligned box', async t => {
    const f = fixture(t);
    const form = f.doc.querySelector('form');
    form.style.cssText = 'position:fixed; bottom:0; display:flex; align-items:center';
    const original = form.outerHTML;
    const controller = f.run(); await tick();
    const bar = f.doc.querySelector('[data-session-stats]');
    assert.equal(form.lastElementChild, bar);
    assert.equal(f.dom.window.getComputedStyle(form).flexWrap, 'wrap');
    controller.stop();
    assert.equal(form.outerHTML, original);
});

for (const layout of ['grid', 'flex']) test(`does not put the footer across the sidebar in a split ${layout}`, async t => {
    const f = fixture(t);
    const main = f.doc.querySelector('main'), form = main.querySelector('form');
    main.style.cssText = `display:${layout}; grid-template-columns: 600px 300px`;
    const sidebar = f.doc.createElement('aside');
    // A top-aligned sidebar can end well above the bottom-aligned composer.
    sidebar.getBoundingClientRect = () => ({ left: 620, right: 920, top: 0, bottom: 200, height: 200, width: 300 });
    main.append(sidebar);
    f.run(); await tick();
    assert.equal(form.lastElementChild, f.doc.querySelector('[data-session-stats]'));
    assert.equal(main.children.length, 2, 'native pane tracks keep their original siblings');
});

function assertStatsRow(bar, previous, win) {
    assert.ok(bar, 'the statistics must be visible');
    const row = bar.closest('[data-session-stats-row]') ?? bar;
    assert.equal(row.parentElement, previous.parentElement, 'the row must stay in the composer column');
    assert.equal(row.previousElementSibling, previous, 'the statistics row must follow the composer controls');
    const rowStyle = win.getComputedStyle(row), barStyle = win.getComputedStyle(bar);
    assert.notEqual(rowStyle.position, 'fixed', 'the row must reserve space in normal flow');
    assert.notEqual(rowStyle.position, 'absolute', 'the row must reserve space in normal flow');
    assert.ok(['block', 'flex', 'grid'].includes(rowStyle.display), 'the statistics must have their own block row');
    const first = bar.querySelector('.session-stats-group:first-child');
    const last = bar.querySelector('.session-stats-group:last-child');
    assert.ok(barStyle.justifyContent === 'center'
        || win.getComputedStyle(first).marginLeft === 'auto' && win.getComputedStyle(last).marginRight === 'auto',
    'the metrics must be horizontally centered in the row');
    if (rowStyle.width.endsWith('px')) {
        assert.ok(parseFloat(rowStyle.width) <= previous.parentElement.getBoundingClientRect().width,
            'the statistics row must fit the composer column');
    } else if (rowStyle.width.endsWith('%')) {
        assert.ok(parseFloat(rowStyle.width) <= 100, 'the statistics row must fit the composer column');
    }
    assert.equal(barStyle.whiteSpace, 'nowrap');
    return row;
}

test('reuses only the bottom padding available to a docked statistics row', async t => {
    const f = lowerControlsFixture(t);
    f.layout({ left: 20, width: 800, buttons: [[510, 135], [670, 135]] });
    f.run(); await tick();
    const win = f.dom.window, bar = f.doc.querySelector('[data-session-stats]');
    const style = win.getComputedStyle(bar);
    assert.equal(style.paddingTop, '0px');
    assert.equal(style.paddingBottom, '0px');
    const main = f.doc.querySelector('main');
    main.style.paddingBottom = '8px';
    main.getBoundingClientRect = () => ({ top: 0, bottom: 640, height: 640 });
    f.wrapper.getBoundingClientRect = () => ({ top: 500, bottom: 632, height: 132, width: 800 });
    bar.getBoundingClientRect = () => {
        const bottom = 632 - (parseFloat(bar.style.marginBottom) || 0);
        return { height: 14, top: bottom - 14, bottom };
    };
    async function reflow() { win.dispatchEvent(new win.Event('resize')); await tick(); }
    await reflow();
    assert.equal(bar.style.marginBottom, '-7px', 'leave one pixel before the window edge');
    await reflow();
    assert.equal(bar.getBoundingClientRect().bottom, 639, 'repeated layout must not drift');
    f.wrapper.style.overflowY = 'hidden';
    await reflow();
    assert.equal(parseFloat(win.getComputedStyle(bar).marginBottom), 0, 'keep the line inside a clipped pane');
    f.wrapper.style.overflowY = 'visible';
    main.style.paddingBottom = '0px';
    await reflow();
    assert.equal(parseFloat(win.getComputedStyle(bar).marginBottom), 0, 'preserve the row when no native padding is available');
});

test('centers statistics in their own normal-flow row below legacy or right-aligned controls', async t => {
    for (const [label, width, buttons] of [
        ['legacy controls at both ends', 600, [[22, 100], [500, 115]]],
        ['new controls on the right', 800, [[470, 140], [630, 185]]],
        ['new controls crossing the composer midpoint', 800, [[410, 170], [630, 185]]],
    ]) await t.test(label, async t => {
        const f = lowerControlsFixture(t);
        f.layout({ left: 20, width, buttons });
        const before = f.wrapper.outerHTML;
        const controller = f.run(); await tick();
        const bar = f.doc.querySelector('[data-session-stats]');
        assertStatsRow(bar, f.controls, f.dom.window);
        assert.equal(f.wrapper.children.length, 3, 'only one statistics row may be added');
        controller.stop();
        assert.equal(f.wrapper.outerHTML, before);
    });
});

test('opening and closing a sidebar keeps one centered statistics row within the composer column', async t => {
    const f = lowerControlsFixture(t);
    f.layout({ left: 20, width: 900, buttons: [[650, 140], [810, 105]] });
    const before = f.wrapper.outerHTML;
    const controller = f.run(); await tick();
    const bar = f.doc.querySelector('[data-session-stats]');
    const row = assertStatsRow(bar, f.controls, f.dom.window);
    for (const layout of [
        { left: 220, width: 700, buttons: [[590, 160], [810, 105]] },
        { left: 220, width: 380, buttons: [[260, 170], [450, 145]] },
        { left: 20, width: 900, buttons: [[650, 140], [810, 105]] },
    ]) {
        f.layout(layout);
        f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));
        await tick();
        assert.equal(f.doc.querySelector('[data-session-stats]'), bar);
        assert.equal(assertStatsRow(bar, f.controls, f.dom.window), row);
        assert.equal(f.wrapper.children.length, 3, 'resizing must not accumulate spacer rows');
    }
    controller.stop();
    assert.equal(f.wrapper.outerHTML, before);
});

test('replacing the composer column moves the existing row and removes the old placeholder', async t => {
    const f = lowerControlsFixture(t);
    f.layout({ left: 20, width: 800, buttons: [[470, 140], [630, 185]] });
    const before = f.wrapper.outerHTML;
    const replacement = f.wrapper.cloneNode(true);
    const originals = [f.wrapper, ...f.wrapper.querySelectorAll('*')];
    const replacements = [replacement, ...replacement.querySelectorAll('*')];
    replacements.forEach((node, i) => {
        const original = originals[i];
        node.getClientRects = original.getClientRects; node.getBoundingClientRect = original.getBoundingClientRect;
    });
    const replacementControls = replacement.lastElementChild;
    const controller = f.run(); await tick();
    const bar = f.doc.querySelector('[data-session-stats]');
    assertStatsRow(bar, f.controls, f.dom.window);
    f.wrapper.replaceWith(replacement); await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), bar);
    assertStatsRow(bar, replacementControls, f.dom.window);
    assert.equal(f.wrapper.outerHTML, before, 'the detached column must not retain a statistics placeholder');
    assert.equal(replacement.children.length, 3);
    controller.stop();
    assert.equal(replacement.outerHTML, before);
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
    const beforeColumn = f.doc.querySelector('main').outerHTML;
    f.run(); await tick();
    assert.equal(f.doc.querySelector('[data-session-stats]'), null);
    assert.equal(f.doc.querySelector('main').outerHTML, beforeColumn, 'pending remote statistics must not reserve an empty row');
    assert.deepEqual(calls, [['remote-stats']]);
    resolveStats({ ...stats, threadId: REMOTE, source: 'remote_control', tps: 41.7 });
    await new Promise(resolve => setTimeout(resolve, 0));
    const bar = f.doc.querySelector('[data-session-stats]');
    assert.match(bar.textContent, /2 turns.*33 steps.*≈ 42 tok\/s.*11\.7M tok.*Cache hit 96%/);
    assert.doesNotMatch(bar.textContent, /context|上下文/i);
    assert.match(f.doc.querySelector('[data-stat="tokens"]').title, /运行端.*会话日志/);
    assert.doesNotMatch(bar.title, /本地/);
    assert.equal(f.doc.querySelector('form').outerHTML, before);
    assertStatsRow(bar, f.doc.querySelector('form'), f.dom.window);
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
