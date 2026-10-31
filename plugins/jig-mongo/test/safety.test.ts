// What the code of the tool is allowed to contain. The model supplies a call; the configuration supplies every address and
// credential; a write is sent from one place each, once; and one file starts a program. These tests read the sources, because a call
// cannot show that a path does not exist.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = fs.readdirSync(src).filter((name) => name.endsWith(".ts"));

/** The code of a file with its comments and strings taken out, so a word in a comment is not a use. */
function codeOf(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/`(?:[^`\\]|\\.)*`/g, "``")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}
const sources = files.map((file) => ({ file, text: fs.readFileSync(path.join(src, file), "utf8") }));
const where = (pattern: RegExp, raw = false): string[] =>
    sources.filter(({ text }) => pattern.test(raw ? text : codeOf(text))).map(({ file }) => file);

describe("the driver and the processes", () => {
    test("only driver.ts loads the driver, and only at run time", () => {
        assert.deepEqual(where(/from "mongodb"|import\("mongodb"\)/, true).sort(), ["driver.ts"]);
        assert.match(fs.readFileSync(path.join(src, "driver.ts"), "utf8"), /import type \* as Mongo from "mongodb"/);
        assert.match(fs.readFileSync(path.join(src, "driver.ts"), "utf8"), /await import\("mongodb"\)/);
    });

    test("no file starts a process but through jig-core's exec, from one file, and none uses a shell or evaluates a string", () => {
        assert.deepEqual(where(/child_process|\bspawn\(|\bexecFile|\bexecSync\(/), []);
        assert.deepEqual(where(/exec\.run\(/), ["session.ts"]);
        assert.deepEqual(where(/\.run\("ssh"/, true), ["route.ts"]);
        assert.deepEqual(where(/\bshell\s*:|\beval\(|new Function\(/), []);
    });

    test("jig-core is reached through its client, its contract and its kit only", () => {
        const imports = sources.flatMap(({ file, text }) =>
            [...text.matchAll(/from "(\.\.\/\.\.\/jig-core\/[^"]+)"/g)].map((match) => `${file}: ${match[1]}`),
        );
        for (const line of imports) assert.match(line, /jig-core\/src\/(?:client|contract|kit\/[a-z-]+)\.ts$/, line);
    });

    test("a secret is resolved in one file, and a password is handed to the driver and to nothing else", () => {
        assert.deepEqual(where(/secrets\.resolve\(/), ["session.ts"]);
        // The configuration holds the reference, the session resolves it, and the driver is the only one that uses the value.
        assert.deepEqual(where(/\.password\b/).sort(), ["config.ts", "driver.ts", "session.ts"]);
    });
});

describe("a write is sent once", () => {
    test("the driver never sends a write again, and no call of the backend sits in a retry loop", () => {
        assert.match(
            codeOf(fs.readFileSync(path.join(src, "driver.ts"), "utf8")) +
                fs.readFileSync(path.join(src, "driver.ts"), "utf8"),
            /retryWrites: false/,
        );
        assert.match(fs.readFileSync(path.join(src, "driver.ts"), "utf8"), /retryReads: false/);
        assert.deepEqual(
            where(/\b(?:retry|attempt)\w*\s*[<+]/).filter((file) => file !== "route.ts"),
            [],
            "only the wait for a local port loops",
        );
        for (const file of ["writes.ts", "tool.ts"]) {
            const code = codeOf(fs.readFileSync(path.join(src, file), "utf8"));
            assert.doesNotMatch(
                code,
                /\b(?:while|for)\s*\([^)]*\)\s*\{[^}]*(?:backend\.(?:update|insert|remove|bulk|replace|createIndex|dropIndex)|\.send\()/,
                file,
            );
        }
    });

    test("each write is sent from one place: the backend's write calls are made in writes.ts only, once each", () => {
        const writes = codeOf(fs.readFileSync(path.join(src, "writes.ts"), "utf8"));
        const count = (pattern: RegExp): number => [...writes.matchAll(pattern)].length;
        assert.equal(count(/backend\.insert\(/g), 1);
        assert.equal(count(/backend\.update\(/g), 1);
        assert.equal(count(/backend\.replace\(/g), 1);
        assert.equal(count(/backend\.remove\(/g), 1);
        assert.equal(count(/backend\.bulk\(/g), 1);
        assert.equal(count(/backend\.createIndex\(/g), 1);
        assert.equal(count(/backend\.dropIndex\(/g), 1);
        assert.deepEqual(where(/\bbackend\.(?:insert|update|replace|remove|bulk|createIndex|dropIndex)\(/), [
            "writes.ts",
        ]);
    });

    test("the tool sends a write only after comparing its fingerprint with the one that was approved, and once", () => {
        const tool = codeOf(fs.readFileSync(path.join(src, "tool.ts"), "utf8"));
        assert.match(tool, /guard\(toolCallId, run\.label, prepared\);/);
        assert.ok(tool.indexOf("guard(toolCallId") < tool.indexOf("prepared.send(req)"));
        assert.equal([...tool.matchAll(/prepared\.send\(/g)].length, 1);
        assert.equal([...tool.matchAll(/prepared\.verify\(/g)].length, 1);
    });

    test("production writes are refused in classify through the kind of the environment, before the call is planned", () => {
        const tool = codeOf(fs.readFileSync(path.join(src, "tool.ts"), "utf8"));
        assert.match(tool, /kindOf\(call\.environment\)/);
        assert.ok(tool.indexOf("production && (") < tool.indexOf("planCall(call, access,"));
    });
});

describe("the access lists", () => {
    test("only access.ts knows the names that are always denied, and the system databases", () => {
        assert.deepEqual(where(/password\|secret\|token\|apikey/i, true), ["access.ts"]);
        assert.deepEqual(where(/"admin", "local", "config"/, true), ["access.ts"]);
    });

    test("a call is planned in one place: plan.ts, which scans for JavaScript first", () => {
        const plan = codeOf(fs.readFileSync(path.join(src, "plan.ts"), "utf8"));
        assert.ok(plan.indexOf("scanJavaScript(") < plan.indexOf("checkPipeline("));
        assert.deepEqual(where(/planCall\(/), ["plan.ts", "tool.ts"]);
    });
});
