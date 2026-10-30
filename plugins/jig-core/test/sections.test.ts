// Plugin sections of jig.json: a plugin registers its section and a check, jig-core validates the section when the
// session starts, and a top-level key nobody registered is an unknown field.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildApi } from "../src/api.ts";
import { publishJig, withdrawJig, withJig } from "../src/client.ts";
import { describeProblem, loadConfigFile, OWN_SECTIONS } from "../src/config.ts";
import type { SectionCheck } from "../src/config.ts";
import { createState, loadPersonalConfig } from "../src/state.ts";

/** A check that wants `{ timeout: <number> }` and names the key in its message, as the contract asks. */
const gitCheck: SectionCheck = (raw) => {
    if (typeof raw !== "object" || raw === null) return ["git must be an object"];
    const timeout = (raw as { timeout?: unknown }).timeout;
    return timeout === undefined || typeof timeout === "number" ? [] : ["git.timeout must be a number"];
};

describe("sections in the file", () => {
    let dir: string;
    let counter = 0;
    before(() => {
        dir = mkdtempSync(path.join(tmpdir(), "jig-sections-"));
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    function write(value: unknown): string {
        const file = path.join(dir, `jig-${counter++}.json`);
        writeFileSync(file, JSON.stringify(value));
        return file;
    }

    test("a registered section that loads", () => {
        const file = write({ git: { timeout: 30 }, rules: [{ tool: "t", decision: "ask" }] });
        const loaded = loadConfigFile(file, new Map([["git", gitCheck]]));
        assert.deepEqual(loaded.problems, []);
        assert.deepEqual(loaded.sections.get("git"), { timeout: 30 });
        // jig-core's own settings load next to it.
        assert.equal(loaded.config.rules.length, 1);
    });

    test("a section that fails its check is lost on its own, and the error names the file and the key", () => {
        const file = write({ git: { timeout: "soon" }, rules: [{ tool: "t", decision: "ask" }] });
        const loaded = loadConfigFile(file, new Map([["git", gitCheck]]));
        assert.equal(loaded.sections.get("git"), undefined);
        assert.equal(loaded.sections.has("git"), false);
        assert.equal(loaded.problems.length, 1);
        assert.deepEqual(loaded.problems[0], { source: file, key: "git", message: "git.timeout must be a number" });
        assert.ok(describeProblem(loaded.problems[0]!).startsWith(file));
        // A mistake in a plugin's section does not cost the user their jig-core rules.
        assert.equal(loaded.config.rules.length, 1);
    });

    test("a top-level key nobody registered is an unknown field, and the defaults apply", () => {
        const file = write({ lens: { port: 3300 }, git: { timeout: 1 }, rules: [{ tool: "t", decision: "ask" }] });
        const loaded = loadConfigFile(file, new Map([["git", gitCheck]]));
        assert.deepEqual(loaded.problems, [{ source: file, key: "lens", message: "is not a known field" }]);
        assert.deepEqual(loaded.config.rules, []);
        // The registered section is still handed to its plugin.
        assert.deepEqual(loaded.sections.get("git"), { timeout: 1 });
    });

    test("with no plugin registered, any section is unknown", () => {
        const loaded = loadConfigFile(write({ git: {} }));
        assert.equal(loaded.problems[0]?.key, "git");
        assert.equal(loaded.problems[0]?.message, "is not a known field");
    });

    test("a registered section that is not in the file is simply absent: no check, no problem", () => {
        let calls = 0;
        const loaded = loadConfigFile(
            write({}),
            new Map([
                [
                    "git",
                    () => {
                        calls++;
                        return [];
                    },
                ],
            ]),
        );
        assert.equal(calls, 0);
        assert.deepEqual(loaded.problems, []);
        assert.equal(loaded.sections.size, 0);
    });

    test("a check that throws, or answers with something else than a list, is a problem and not a crash", () => {
        const file = write({ a: 1, b: 2 });
        const checks = new Map<string, SectionCheck>([
            [
                "a",
                () => {
                    throw new Error("boom");
                },
            ],
            ["b", (() => "fine") as unknown as SectionCheck],
        ]);
        const loaded = loadConfigFile(file, checks);
        assert.equal(loaded.sections.size, 0);
        assert.equal(loaded.problems.length, 2);
        assert.match(loaded.problems.find((problem) => problem.key === "a")?.message ?? "", /check failed: boom/);
        assert.match(loaded.problems.find((problem) => problem.key === "b")?.message ?? "", /did not return a list/);
    });

    test("the messages a check returns are kept short and printable", () => {
        const loaded = loadConfigFile(write({ x: 1 }), new Map([["x", () => [`x\u0007bad ${"y".repeat(1000)}`]]]));
        const message = loaded.problems[0]?.message ?? "";
        assert.ok(message.length <= 300);
        assert.ok(!message.includes("\u0007"));
    });

    test("several messages from one check are all reported", () => {
        const loaded = loadConfigFile(write({ x: 1 }), new Map([["x", () => ["x.one is wrong", "x.two is wrong"]]]));
        assert.deepEqual(
            loaded.problems.map((problem) => problem.message),
            ["x.one is wrong", "x.two is wrong"],
        );
    });
});

describe("through the API", () => {
    let dir: string;
    before(() => {
        dir = mkdtempSync(path.join(tmpdir(), "jig-sections-api-"));
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    function setup(content: unknown) {
        const file = path.join(dir, "jig.json");
        writeFileSync(file, JSON.stringify(content));
        const state = createState({} as ExtensionAPI);
        return { state, api: buildApi(state), file };
    }

    test("a registered section is read back after the session starts", () => {
        const { state, api, file } = setup({ git: { timeout: 30 } });
        api.config.registerSection("git", gitCheck);
        assert.equal(api.config.section("git"), undefined, "nothing is loaded before the session starts");
        loadPersonalConfig(state, file);
        assert.deepEqual(api.config.section("git"), { timeout: 30 });
        assert.deepEqual(state.policy().problems, []);
    });

    test("a section that fails validation reads back as undefined, and the problem is reported", () => {
        const { state, api, file } = setup({ git: { timeout: "soon" } });
        api.config.registerSection("git", gitCheck);
        loadPersonalConfig(state, file);
        assert.equal(api.config.section("git"), undefined);
        const problems = state.policy().problems.map(describeProblem);
        assert.deepEqual(problems, [`${file}: git: git.timeout must be a number`]);
    });

    test("an unregistered top-level key is reported as unknown", () => {
        const { state, api, file } = setup({ lens: {} });
        loadPersonalConfig(state, file);
        assert.equal(api.config.section("lens"), undefined);
        assert.deepEqual(state.policy().problems.map(describeProblem), [`${file}: lens: is not a known field`]);
    });

    test("a section that is not in the file reads back as undefined, with no problem", () => {
        const { state, api, file } = setup({});
        api.config.registerSection("git", gitCheck);
        loadPersonalConfig(state, file);
        assert.equal(api.config.section("git"), undefined);
        assert.deepEqual(state.policy().problems, []);
    });

    test("a section name that clashes with a jig-core field is refused with an error", () => {
        const { api, state } = setup({});
        for (const name of OWN_SECTIONS) {
            assert.throws(
                () => api.config.registerSection(name, () => []),
                new RegExp(`"${name}" is a jig-core field`),
                name,
            );
        }
        assert.equal(state.sectionChecks.size, 0);
    });

    test("a section needs a name and a check", () => {
        const { api } = setup({});
        assert.throws(() => api.config.registerSection("", () => []), TypeError);
        assert.throws(() => api.config.registerSection("x", undefined as never), TypeError);
    });

    test("registering a section again replaces the check", () => {
        const { state, api, file } = setup({ x: 1 });
        api.config.registerSection("x", () => ["first check"]);
        api.config.registerSection("x", () => []);
        loadPersonalConfig(state, file);
        assert.equal(api.config.section("x"), 1);
    });

    test("a section registered after the file was read is checked at once", () => {
        const { state, api, file } = setup({ git: { timeout: 5 } });
        loadPersonalConfig(state, file);
        assert.equal(state.policy().problems.length, 1, "unknown until someone registers it");
        api.config.registerSection("git", gitCheck);
        assert.deepEqual(api.config.section("git"), { timeout: 5 });
        assert.deepEqual(state.policy().problems, []);
    });

    test("asking for a section before the session started reads the file then, so load order does not matter", () => {
        const { state, api, file } = setup({ git: { timeout: 7 } });
        state.configPath = () => file;
        api.config.registerSection("git", gitCheck);
        assert.equal(state.configLoaded, false);
        assert.deepEqual(api.config.section("git"), { timeout: 7 });
        assert.equal(state.configLoaded, true);
    });

    test("a plugin that loaded before jig-core registers its section as soon as jig-core publishes the API", () => {
        const { state, api, file } = setup({ git: { timeout: 5 } });
        withJig((early) => early.config.registerSection("git", gitCheck));
        assert.equal(state.sectionChecks.size, 0, "not yet: jig-core has not published");
        try {
            publishJig(api);
            assert.equal(state.sectionChecks.size, 1);
            loadPersonalConfig(state, file);
            assert.deepEqual(api.config.section("git"), { timeout: 5 });
        } finally {
            withdrawJig(api);
        }
    });
});
