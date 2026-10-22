'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.id !== 'com.kpk.session-stats' || manifest.scope !== 'both' || manifest.version !== pkg.version)
    throw new Error('Invalid manifest identity, scope or version');
if (manifest.main !== 'index.js' || !/^\d+\.\d+\.\d+$/.test(manifest.minRuntime)
    || !/^[\w.-]+\/[\w.-]+$/.test(manifest.githubRepo)) throw new Error('Invalid manifest entry or compatibility');
for (const name of ['index.js', 'icon.svg', 'Inject-ClaudePlusPlus.ps1', 'Uninject-ClaudePlusPlus.ps1'])
    if (!fs.statSync(path.join(root, name)).isFile()) throw new Error(`Missing ${name}`);
execFileSync(process.execPath, [path.join(__dirname, 'build.cjs'), '--check'], { stdio: 'inherit' });
const moduleBox = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), { module: moduleBox });
if (typeof moduleBox.exports.start !== 'function' || typeof moduleBox.exports.stop !== 'function')
    throw new Error('Entry cannot be evaluated in isolated renderer without require');
console.log('Manifest, package, renderer bundle and install entry points verified.');
