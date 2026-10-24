'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('generated entry waits for publisher cleanup before starting a replacement', async () => {
    const box = { exports: {} }, cleanup = [];
    let starts = 0;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8'), {
        module: box,
        require(name) {
            assert.equal(name, './src/main.cjs');
            return { startMain() { starts++; return { stop: () => new Promise(resolve => cleanup.push(resolve)) }; } };
        },
    });
    const entry = box.exports;
    await entry.start({ process: 'main' });
    const replacement = entry.start({ process: 'main' });
    assert.equal(starts, 1);
    assert.equal(cleanup.length, 1);
    cleanup[0](); await replacement;
    assert.equal(starts, 2);
    let settled = false;
    const stop = Promise.resolve(entry.stop()).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    cleanup[1](); await stop;
});
