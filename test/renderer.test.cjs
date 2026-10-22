'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { parseSessionId, findComposer, startRenderer } = require('../src/renderer.cjs');
const ID = 'local_11111111-1111-4111-8111-111111111111';
const OTHER = 'local_22222222-2222-4222-8222-222222222222';
const stats = { status: 'ok', turns: 2, steps: 33, tps: null, totalTokens: 11700000,
    inputTokens: 11000000, outputTokens: 700000, cachedInputTokens: 10560000, cacheHit: 0.96 };
function fixture(t) {
    const dom = new JSDOM('<main><form><div class="ProseMirror" contenteditable="true"></div>'
        + '<button type="submit">Send</button></form></main>', { url: `https://claude.ai/epitaxy/${ID}` });
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
test('only local Claude Code routes produce identities', () => {
    for (const origin of ['https://claude.ai', 'app://localhost'])
        assert.equal(parseSessionId(`${origin}/epitaxy/${ID}`), ID);
    for (const url of [`https://evil.example/epitaxy/${ID}`, 'https://claude.ai/new',
        `https://claude.ai/chat/${ID}`, `https://claude.ai/epitaxy/${ID}/extra`,
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
