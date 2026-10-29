// Paths and private files: where the state lives, and that what is written there is private.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { appendPrivateLine, configFile, createPrivateFile, privateDir, removeIfEmpty, removeOldFiles, stateDir } from "../src/paths.ts";
import { tempState } from "./support/state.ts";

const mode = (file: string) => statSync(file).mode & 0o777;

describe("the state folder", () => {
    test("is $JIG_STATE_DIR when set", () => {
        assert.equal(stateDir({ JIG_STATE_DIR: "/tmp/somewhere/jig-state" }), "/tmp/somewhere/jig-state");
    });

    test("is jig under $XDG_STATE_HOME otherwise", () => {
        assert.equal(stateDir({ XDG_STATE_HOME: "/var/xdg" }), "/var/xdg/jig");
    });

    test("is ~/.local/state/jig by default, and a relative XDG_STATE_HOME is ignored", () => {
        const expected = path.join(homedir(), ".local", "state", "jig");
        assert.equal(stateDir({}), expected);
        assert.equal(stateDir({ XDG_STATE_HOME: "relative/dir" }), expected);
        assert.equal(stateDir({ JIG_STATE_DIR: "" }), expected, "an empty variable counts as not set");
    });

    test("$JIG_STATE_DIR wins over $XDG_STATE_HOME", () => {
        assert.equal(stateDir({ JIG_STATE_DIR: "/a", XDG_STATE_HOME: "/b" }), "/a");
    });
});

describe("the configuration file", () => {
    test("is jig.json in Pi's agent folder, so a separate Pi profile has its own", () => {
        assert.equal(configFile("/home/u/.pi/agent"), "/home/u/.pi/agent/jig.json");
        assert.equal(configFile("/profiles/work/agent"), "/profiles/work/agent/jig.json");
    });
});

describe("private folders and files", () => {
    const state = tempState();
    before(() => { state.start(); });
    after(() => state.stop());

    test("folders under the state folder are 0700, the state folder too", () => {
        const dir = privateDir("a", "b");
        assert.equal(dir, path.join(state.dir, "a", "b"));
        for (const folder of [state.dir, path.join(state.dir, "a"), dir]) assert.equal(mode(folder), 0o700, folder);
    });

    test("a folder that already existed with wider rights is tightened", () => {
        const dir = path.join(state.dir, "wide");
        mkdirSync(dir, { mode: 0o755 });
        privateDir("wide");
        assert.equal(mode(dir), 0o700);
    });

    test("appended lines go to a 0600 file, one after another", () => {
        const file = path.join(privateDir("lines"), "x.jsonl");
        appendPrivateLine(file, "one\n");
        appendPrivateLine(file, "two\n");
        assert.equal(readFileSync(file, "utf8"), "one\ntwo\n");
        assert.equal(mode(file), 0o600);
    });

    test("an existing file with wider rights is tightened when a line is appended", () => {
        const file = path.join(privateDir("lines"), "wide.jsonl");
        writeFileSync(file, "old\n", { mode: 0o644 });
        appendPrivateLine(file, "new\n");
        assert.equal(mode(file), 0o600);
    });

    test("a new private file is 0600, and an existing one is not overwritten", () => {
        const file = path.join(privateDir("spill"), "one.txt");
        createPrivateFile(file, "first");
        assert.equal(mode(file), 0o600);
        assert.throws(() => createPrivateFile(file, "second"), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
        assert.equal(readFileSync(file, "utf8"), "first");
    });
});

describe("removing old files", () => {
    let dir: string;
    before(() => { dir = mkdtempSync(path.join(tmpdir(), "jig-old-")); });
    after(() => rmSync(dir, { recursive: true, force: true }));

    test("deletes regular files older than the limit, keeps newer ones and folders", () => {
        const day = 24 * 60 * 60 * 1000;
        const old = path.join(dir, "old.txt");
        const fresh = path.join(dir, "fresh.txt");
        writeFileSync(old, "x");
        writeFileSync(fresh, "x");
        mkdirSync(path.join(dir, "folder"));
        const now = Date.now();
        utimesSync(old, new Date(now - 10 * day), new Date(now - 10 * day));
        assert.equal(removeOldFiles(dir, 7, now), 1);
        assert.equal(existsSync(old), false);
        assert.equal(existsSync(fresh), true);
        assert.equal(existsSync(path.join(dir, "folder")), true);
    });

    test("a missing folder counts as empty", () => {
        assert.equal(removeOldFiles(path.join(dir, "nope"), 7), 0);
    });

    test("removeIfEmpty removes an empty folder and leaves a full one", () => {
        const empty = path.join(dir, "empty");
        const full = path.join(dir, "full");
        mkdirSync(empty);
        mkdirSync(full);
        writeFileSync(path.join(full, "f"), "x");
        removeIfEmpty(empty);
        removeIfEmpty(full);
        removeIfEmpty(path.join(dir, "never-existed"));
        assert.equal(existsSync(empty), false);
        assert.equal(existsSync(full), true);
    });
});
