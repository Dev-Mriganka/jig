// Finding programs on PATH, and opening the browser. The browsers here are scripts that write down what they got.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { browserOpener, findProgram } from "../src/programs.ts";
import { tempState } from "./support.ts";

/** An executable file, or with `mode` something else. */
function program(folder: string, name: string, text = "#!/bin/sh\nexit 0\n", mode = 0o755): string {
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, name);
    writeFileSync(file, text);
    chmodSync(file, mode);
    return file;
}

test("the first executable of the first name that is on PATH is found", (t) => {
    const root = tempState(t);
    const bin1 = path.join(root, "one");
    const bin2 = path.join(root, "two");
    const grafana = program(bin2, "grafana");
    program(bin1, "grafana-server");
    const env = { PATH: `${bin1}:${bin2}` };
    assert.equal(
        findProgram(["grafana", "grafana-server"], env),
        grafana,
        "the name that is preferred, wherever it is",
    );
    assert.equal(findProgram(["grafana-server"], env), path.join(bin1, "grafana-server"));
    assert.equal(findProgram(["datasette"], env), undefined);
});

test("the earlier folder of PATH wins when a name is in both", (t) => {
    const root = tempState(t);
    const first = program(path.join(root, "one"), "datasette");
    program(path.join(root, "two"), "datasette");
    assert.equal(findProgram(["datasette"], { PATH: `${path.join(root, "one")}:${path.join(root, "two")}` }), first);
});

test("a file that is not executable, and a folder with the program's name, are not programs", (t) => {
    const root = tempState(t);
    program(path.join(root, "bin"), "grafana", "text", 0o644);
    mkdirSync(path.join(root, "bin", "datasette"));
    assert.equal(findProgram(["grafana", "datasette"], { PATH: path.join(root, "bin") }), undefined);
});

test("a relative folder in PATH is never searched: the current folder is a project the agent works in", (t) => {
    const root = tempState(t);
    const project = path.join(root, "project");
    program(project, "grafana");
    const cwd = process.cwd();
    process.chdir(project);
    try {
        for (const PATH of [".", "", "bin:.", `:${path.join(root, "empty")}`, "project"]) {
            assert.equal(findProgram(["grafana"], { PATH }), undefined, JSON.stringify(PATH));
        }
    } finally {
        process.chdir(cwd);
    }
});

test("no PATH finds nothing", () => {
    assert.equal(findProgram(["grafana"], {}), undefined);
});

// ---- the browser ----------------------------------------------------------------------------------------------------

/** A browser that writes its arguments, one to a line, into `out`. */
function browser(root: string, name: string): { file: string; out: string } {
    const out = path.join(root, `${name}.args`);
    return { file: program(path.join(root, "browsers"), name, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n`), out };
}

async function argumentsOf(out: string): Promise<string[]> {
    for (let i = 0; i < 200; i++) {
        if (existsSync(out)) {
            const text = readFileSync(out, "utf8");
            if (text.endsWith("\n")) return text.slice(0, -1).split("\n");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${out} was never written`);
}

const finding = (table: Record<string, string>) => (names: readonly string[]) =>
    names.map((name) => table[name]).find((file) => file !== undefined);

const URL = "http://127.0.0.1:3300/d/jig-overview";

test("$BROWSER is run with its own arguments, and then the address", async (t: TestContext) => {
    const root = tempState(t);
    const { file, out } = browser(root, "mybrowser");
    const open = browserOpener({ BROWSER: `${file} --new-window --incognito` }, finding({}), "linux");
    assert.equal(await open(URL), true);
    assert.deepEqual(await argumentsOf(out), ["--new-window", "--incognito", URL]);
});

test("$BROWSER may be a name that is on PATH", async (t) => {
    const root = tempState(t);
    const { file, out } = browser(root, "mybrowser");
    const open = browserOpener({ BROWSER: "mybrowser" }, finding({ mybrowser: file }), "linux");
    assert.equal(await open(URL), true);
    assert.deepEqual(await argumentsOf(out), [URL]);
});

test("without $BROWSER, xdg-open opens it", async (t) => {
    const root = tempState(t);
    const { file, out } = browser(root, "xdg-open");
    const open = browserOpener({}, finding({ "xdg-open": file }), "linux");
    assert.equal(await open(URL), true);
    assert.deepEqual(await argumentsOf(out), [URL]);
});

test("an empty $BROWSER is the same as none", async (t) => {
    const root = tempState(t);
    const { file, out } = browser(root, "xdg-open");
    const open = browserOpener({ BROWSER: "  " }, finding({ "xdg-open": file }), "linux");
    assert.equal(await open(URL), true);
    assert.deepEqual(await argumentsOf(out), [URL]);
});

test("a $BROWSER that is not there falls back to xdg-open, with the address only", async (t) => {
    const root = tempState(t);
    const { file, out } = browser(root, "xdg-open");
    const open = browserOpener({ BROWSER: "nosuchbrowser --flag" }, finding({ "xdg-open": file }), "linux");
    assert.equal(await open(URL), true);
    assert.deepEqual(await argumentsOf(out), [URL]);
});

test("on macOS, open is the last choice; elsewhere it is not tried, because it can be another program", async (t) => {
    const root = tempState(t);
    const { file, out } = browser(root, "open");
    const mac = browserOpener({}, finding({ open: file }), "darwin");
    assert.equal(await mac(URL), true);
    assert.deepEqual(await argumentsOf(out), [URL]);
    const linux = browserOpener({}, finding({ open: file }), "linux");
    assert.equal(await linux(URL), false);
});

test("with nothing to open it with, there is no browser to be had", async () => {
    assert.equal(await browserOpener({}, finding({}), "linux")(URL), false);
});

test("a program that cannot be started is no browser", async (t) => {
    const root = tempState(t);
    const broken = program(path.join(root, "bin"), "xdg-open", "#!/nonexistent/interpreter\n");
    assert.equal(await browserOpener({}, finding({ "xdg-open": broken }), "linux")(URL), false);
});

test("the address goes to the browser as one argument, never read by a shell", async (t) => {
    const root = tempState(t);
    const { file, out } = browser(root, "xdg-open");
    const open = browserOpener({}, finding({ "xdg-open": file }), "linux");
    const odd = "http://127.0.0.1:3300/d/x?a=1&b=$(touch pwned);`id`";
    assert.equal(await open(odd), true);
    assert.deepEqual(await argumentsOf(out), [odd]);
    assert.equal(existsSync("pwned"), false);
});
