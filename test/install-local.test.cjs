"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const source = path.resolve(__dirname, "..");
const id = "com.kpk.session-stats";
const windows = { skip: process.platform !== "win32" };

function fixture(t, { initializeHome = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-stats-install-"));
    const tweakSource = path.join(root, "Session Stats source");
    const appData = path.join(root, "AppData", "Roaming");
    const home = path.join(appData, "claude-plusplus");
    const tweaks = path.join(home, "tweaks");
    const link = path.join(tweaks, id);
    const configFile = path.join(home, "config.json");
    t.after(() => {
        assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
        if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
        fs.rmSync(root, { recursive: true });
        assert.equal(fs.existsSync(root), false);
    });
    fs.mkdirSync(path.join(tweakSource, "scripts"), { recursive: true });
    for (const file of ["Inject-ClaudePlusPlus.ps1", "Uninject-ClaudePlusPlus.ps1", "scripts/install-local.ps1"]) {
        fs.copyFileSync(path.join(source, file), path.join(tweakSource, file));
    }
    fs.writeFileSync(path.join(tweakSource, "manifest.json"), JSON.stringify({
        id, name: "Session Stats", main: "index.js",
    }));
    fs.writeFileSync(path.join(tweakSource, "index.js"), "module.exports = {};\n");
    const config = { claudePlusPlus: { autoUpdate: false, safeMode: true }, tweaks: {
        "other.tweak": { enabled: false }, [id]: { enabled: false, retained: "value" },
    }, retained: [1, "中文"] };
    if (initializeHome) {
        fs.mkdirSync(tweaks, { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify(config));
        fs.mkdirSync(path.join(tweaks, "other.tweak"));
        fs.writeFileSync(path.join(tweaks, "other.tweak", "sentinel"), "keep");
    }
    return {
        root, tweakSource, appData, home, link, configFile, config,
        run(action, ...args) {
            return spawnSync("pwsh", ["-NoProfile", "-File",
                path.join(tweakSource, `${action}-ClaudePlusPlus.ps1`), ...args], {
                env: { ...process.env, APPDATA: appData }, encoding: "utf8", timeout: 20000,
            });
        },
        readConfig: () => JSON.parse(fs.readFileSync(configFile, "utf8")),
    };
}

function succeeds(result) {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ""}`);
}

test("Inject links and enables only this tweak, is idempotent, and Uninject preserves its source", windows, (t) => {
    const f = fixture(t);
    succeeds(f.run("Inject"));
    assert.equal(fs.lstatSync(f.link).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(f.link).toLowerCase(), f.tweakSource.toLowerCase());
    const expected = structuredClone(f.config);
    expected.tweaks[id].enabled = true;
    assert.deepEqual(f.readConfig(), expected);
    const written = fs.readFileSync(f.configFile, "utf8");
    succeeds(f.run("Inject"));
    assert.equal(fs.readFileSync(f.configFile, "utf8"), written);
    succeeds(f.run("Uninject"));
    assert.equal(fs.existsSync(f.link), false);
    assert.equal(fs.existsSync(path.join(f.tweakSource, "manifest.json")), true);
    assert.equal(fs.readFileSync(path.join(f.tweakSource, "index.js"), "utf8"), "module.exports = {};\n");
    assert.deepEqual(f.readConfig(), f.config);
    assert.equal(fs.readFileSync(path.join(f.home, "tweaks", "other.tweak", "sentinel"), "utf8"), "keep");
    succeeds(f.run("Uninject"));
});

test("CheckOnly leaves both missing and existing installations unchanged", windows, (t) => {
    const f = fixture(t);
    const before = fs.readFileSync(f.configFile, "utf8");
    succeeds(f.run("Inject", "-CheckOnly"));
    succeeds(f.run("Uninject", "-CheckOnly"));
    assert.equal(fs.existsSync(f.link), false);
    assert.equal(fs.readFileSync(f.configFile, "utf8"), before);
    succeeds(f.run("Inject"));
    const enabled = fs.readFileSync(f.configFile, "utf8");
    succeeds(f.run("Inject", "-CheckOnly"));
    succeeds(f.run("Uninject", "-CheckOnly"));
    assert.equal(fs.lstatSync(f.link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(f.configFile, "utf8"), enabled);
});

test("Store copy is enabled and disabled without deleting or replacing its files", windows, (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.link);
    fs.writeFileSync(path.join(f.link, "manifest.json"), JSON.stringify({ id }));
    fs.writeFileSync(path.join(f.link, "sentinel"), "store source");
    const before = fs.readFileSync(f.configFile, "utf8");
    succeeds(f.run("Inject", "-CheckOnly"));
    succeeds(f.run("Uninject", "-CheckOnly"));
    assert.equal(fs.readFileSync(f.configFile, "utf8"), before);
    assert.equal(fs.readFileSync(path.join(f.link, "sentinel"), "utf8"), "store source");
    succeeds(f.run("Inject"));
    assert.equal(f.readConfig().tweaks[id].enabled, true);
    assert.equal(fs.lstatSync(f.link).isSymbolicLink(), false);
    succeeds(f.run("Uninject"));
    assert.equal(f.readConfig().tweaks[id].enabled, false);
    assert.equal(fs.readFileSync(path.join(f.link, "sentinel"), "utf8"), "store source");
});

test("foreign junctions and unrelated directories are blocked without mutation", windows, (t) => {
    const f = fixture(t);
    const foreign = path.join(f.root, "foreign source");
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, "sentinel"), "keep");
    fs.symlinkSync(foreign, f.link, "junction");
    const before = fs.readFileSync(f.configFile, "utf8");
    for (const action of ["Inject", "Uninject"]) assert.equal(f.run(action).status, 2);
    assert.equal(fs.realpathSync(f.link), fs.realpathSync(foreign));
    assert.equal(fs.readFileSync(path.join(foreign, "sentinel"), "utf8"), "keep");
    fs.unlinkSync(f.link);
    fs.mkdirSync(f.link);
    fs.writeFileSync(path.join(f.link, "manifest.json"), JSON.stringify({ id: "other.tweak" }));
    for (const action of ["Inject", "Uninject"]) assert.equal(f.run(action).status, 2);
    assert.equal(fs.readFileSync(f.configFile, "utf8"), before);
});

test("invalid config is rejected before installing or removing a junction", windows, (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.configFile, "{broken");
    assert.equal(f.run("Inject").status, 1);
    assert.equal(fs.existsSync(f.link), false);
    fs.symlinkSync(f.tweakSource, f.link, "junction");
    assert.equal(f.run("Uninject").status, 1);
    assert.equal(fs.lstatSync(f.link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(f.configFile, "utf8"), "{broken");
});

test("Inject creates missing config without requiring or modifying the Claude++ runtime", windows, (t) => {
    const f = fixture(t);
    fs.unlinkSync(f.configFile);
    succeeds(f.run("Inject"));
    assert.deepEqual(f.readConfig(), { tweaks: { [id]: { enabled: true } } });
    assert.equal(fs.existsSync(path.join(f.home, "runtime")), false);
    succeeds(f.run("Uninject"));
});

test("CheckOnly and missing Uninject do not create an absent Claude++ home", windows, (t) => {
    const f = fixture(t, { initializeHome: false });
    succeeds(f.run("Inject", "-CheckOnly"));
    succeeds(f.run("Uninject", "-CheckOnly"));
    succeeds(f.run("Uninject"));
    assert.equal(fs.existsSync(f.appData), false);
    succeeds(f.run("Inject"));
    assert.deepEqual(f.readConfig(), { tweaks: { [id]: { enabled: true } } });
    succeeds(f.run("Uninject"));
});

test("invalid source manifest or missing entry point is rejected without installing", windows, (t) => {
    const f = fixture(t);
    const before = fs.readFileSync(f.configFile, "utf8");
    const manifestFile = path.join(f.tweakSource, "manifest.json");
    fs.writeFileSync(manifestFile, JSON.stringify({ id: "other.tweak", main: "index.js" }));
    assert.equal(f.run("Inject").status, 1);
    fs.writeFileSync(manifestFile, JSON.stringify({ id, main: "missing.js" }));
    assert.equal(f.run("Inject", "-CheckOnly").status, 1);
    assert.equal(fs.existsSync(f.link), false);
    assert.equal(fs.readFileSync(f.configFile, "utf8"), before);
});

test("non-object config settings are rejected before installing or removing", windows, (t) => {
    const f = fixture(t);
    for (const invalid of [[], { tweaks: [] }, { tweaks: { [id]: [] } }]) {
        const serialized = JSON.stringify(invalid);
        fs.writeFileSync(f.configFile, serialized);
        assert.equal(f.run("Inject").status, 1);
        assert.equal(fs.existsSync(f.link), false);
        fs.symlinkSync(f.tweakSource, f.link, "junction");
        assert.equal(f.run("Uninject").status, 1);
        assert.equal(fs.lstatSync(f.link).isSymbolicLink(), true);
        assert.equal(fs.readFileSync(f.configFile, "utf8"), serialized);
        fs.unlinkSync(f.link);
    }
});
