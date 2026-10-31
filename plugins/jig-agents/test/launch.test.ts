// How a child is started: the command line is built from fixed parts and never holds a flag that would give a child fewer extensions;
// the environment keeps only the names a child needs; the model is checked against the user's list.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { readRolePolicy, ROLE_POLICY_VARIABLE, writeRolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import { settingsFrom } from "../src/config.ts";
import { thisPi } from "../src/host.ts";
import {
    chooseModel,
    childEnvironment,
    flagsFor,
    NEVER_PASSED,
    patternAllows,
    readEnabledModels,
    StartError,
} from "../src/launch.ts";
import { loadRoles, parseRole, shippedFolder } from "../src/roles.ts";
import type { Role } from "../src/roles.ts";

const role = (over: Partial<Role> = {}): Role => ({
    name: "scout",
    description: "d",
    tools: ["read", "grep"],
    writes: false,
    prompt: "p",
    file: "/x.md",
    ...over,
});

describe("the command line", () => {
    test("has Pi's RPC mode, the session id, the role's tools and prompt file, and no children of its own", () => {
        const flags = flagsFor({
            role: role(),
            model: undefined,
            sessionId: "agent-abc123",
            promptFile: "/run/system-prompt.md",
        });
        assert.deepEqual(flags, [
            "--mode",
            "rpc",
            "--session-id",
            "agent-abc123",
            "--tools",
            "read,grep",
            "--exclude-tools",
            "subagent,mcp__*",
            "--append-system-prompt",
            "/run/system-prompt.md",
            "--no-approve",
        ]);
    });

    test("passes the model and the thinking level when there is one", () => {
        const flags = flagsFor({
            role: role(),
            model: { model: "p/m", thinking: "high", source: "role" },
            sessionId: "s",
            promptFile: "f",
        });
        assert.deepEqual(flags.slice(4, 8), ["--model", "p/m", "--thinking", "high"]);
    });

    test("starts with no skills but the ones given: --no-skills, then one --skill for each, before the prompt", () => {
        const flags = flagsFor({
            role: role(),
            model: undefined,
            sessionId: "s",
            promptFile: "f",
            skillFiles: ["/pkg/plugins/jig-git/skills/git/SKILL.md", "/home/me/skills/house/SKILL.md"],
        });
        assert.deepEqual(flags.slice(flags.indexOf("--no-skills")), [
            "--no-skills",
            "--skill",
            "/pkg/plugins/jig-git/skills/git/SKILL.md",
            "--skill",
            "/home/me/skills/house/SKILL.md",
            "--append-system-prompt",
            "f",
            "--no-approve",
        ]);
    });

    test("a role that sees no skill gets --no-skills and nothing after it; left out, Pi finds skills as it always does", () => {
        const none = flagsFor({ role: role(), model: undefined, sessionId: "s", promptFile: "f", skillFiles: [] });
        assert.ok(none.includes("--no-skills"));
        assert.ok(!none.includes("--skill"));
        const left = flagsFor({ role: role(), model: undefined, sessionId: "s", promptFile: "f" });
        assert.ok(!left.includes("--no-skills"));
    });

    test("context none is --no-context-files, and the default passes nothing", () => {
        const spec = { role: role(), model: undefined, sessionId: "s", promptFile: "f" };
        assert.ok(flagsFor({ ...spec, context: "none" }).includes("--no-context-files"));
        assert.ok(!flagsFor({ ...spec, context: "project" }).includes("--no-context-files"));
        assert.ok(!flagsFor(spec).includes("--no-context-files"));
    });

    test("the thinking level goes after the model, or alone when there is no model to carry it", () => {
        const spec = { role: role(), sessionId: "s", promptFile: "f" };
        assert.deepEqual(flagsFor({ ...spec, model: undefined, thinking: "high" }).slice(4, 6), ["--thinking", "high"]);
        const withModel = flagsFor({
            ...spec,
            model: { model: "p/m", thinking: "low", source: "role" },
            thinking: "high",
        });
        assert.deepEqual(
            withModel.slice(4, 8),
            ["--model", "p/m", "--thinking", "low"],
            "the model's own level is the final one",
        );
        assert.ok(!flagsFor({ ...spec, model: { model: "p/m", source: "role" } }).includes("--thinking"));
    });

    test("a role without a tools list (one that writes) leaves Pi's usual tools, minus the excluded ones", () => {
        const flags = flagsFor({
            role: role({ tools: undefined, writes: true }),
            model: undefined,
            sessionId: "s",
            promptFile: "f",
        });
        assert.ok(!flags.includes("--tools"));
        assert.equal(flags[flags.indexOf("--exclude-tools") + 1], "subagent,mcp__*");
    });

    test("a role that names an MCP tool keeps it: the allow list narrows MCP to what it names", () => {
        const flags = flagsFor({
            role: role({ tools: ["read", "mcp__docs__search"] }),
            model: undefined,
            sessionId: "s",
            promptFile: "f",
        });
        assert.equal(flags[flags.indexOf("--exclude-tools") + 1], "subagent");
    });

    test("never holds a flag that would give a child fewer extensions or more trust, whatever the role, model or tools", () => {
        const roles = [...loadRoles([shippedFolder()]).roles.values()];
        assert.ok(roles.length >= 3);
        for (const r of roles) {
            for (const model of [undefined, { model: "p/m", thinking: "low", source: "role" as const }]) {
                const flags = flagsFor({ role: r, model, sessionId: "agent-1", promptFile: "/f.md" });
                for (const flag of NEVER_PASSED) assert.ok(!flags.includes(flag), `${r.name}: ${flag}`);
            }
        }
        assert.deepEqual(NEVER_PASSED, ["--no-extensions", "-ne", "-e", "--extension", "--approve", "-a"]);
    });
});

describe("the environment", () => {
    const who = { id: "abc123", name: "scout-1", role: "scout", parentSession: "sess-1", parentPid: 4242 };

    test("keeps the names a child needs and nothing else, a key, token or password included", () => {
        const env = childEnvironment(
            {
                PATH: "/bin",
                HOME: "/home/me",
                USER: "me",
                LANG: "C",
                LC_ALL: "C",
                XDG_STATE_HOME: "/s",
                TERM: "xterm",
                TZ: "UTC",
                PI_CODING_AGENT_DIR: "/agent",
                JIG_STATE_DIR: "/state",
                JIG_CONDITION: "with-tool-x",
                HTTPS_PROXY: "http://proxy",
                SSL_CERT_FILE: "/ca.pem",
                GITHUB_TOKEN: "t",
                AWS_SECRET_ACCESS_KEY: "k",
                ANTHROPIC_API_KEY: "k2",
                DB_PASSWORD: "p",
                MODEL_API_KEY: "wanted",
            },
            ["MODEL_API_KEY"],
            who,
        );
        for (const name of [
            "PATH",
            "HOME",
            "USER",
            "LANG",
            "LC_ALL",
            "XDG_STATE_HOME",
            "TERM",
            "TZ",
            "PI_CODING_AGENT_DIR",
            "JIG_STATE_DIR",
            "JIG_CONDITION",
            "HTTPS_PROXY",
            "SSL_CERT_FILE",
            "MODEL_API_KEY",
        ]) {
            assert.ok(name in env, name);
        }
        for (const name of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "DB_PASSWORD"])
            assert.ok(!(name in env), name);
        assert.equal(env.JIG_CONDITION, "with-tool-x", "the condition tag reaches the child unchanged");
    });

    test("tells the child who it is, for jig-core's records, jig-theme and jig-review, and its own parent check", () => {
        const env = childEnvironment({ PI_SUBAGENT_ID: "grandparent" }, [], who);
        assert.equal(env.PI_SUBAGENT_ID, "abc123");
        assert.equal(env.PI_SUBAGENT_NAME, "scout-1");
        assert.equal(env.PI_SUBAGENT_PARENT_PID, "4242");
        assert.equal(env.JIG_PARENT_SESSION, "sess-1");
        assert.equal(env.JIG_AGENT_ROLE, "scout");
        assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
    });

    test("carries the role's policy in JIG_ROLE_POLICY, and never the parent's own", () => {
        const policy = writeRolePolicy({ role: "scout", writes: false, actions: { git: ["status"] }, ask: {} });
        const env = childEnvironment(
            { [ROLE_POLICY_VARIABLE]: "the parent's own", PATH: "/bin" },
            [ROLE_POLICY_VARIABLE],
            {
                ...who,
                policy,
            },
        );
        assert.equal(env[ROLE_POLICY_VARIABLE], policy);
        assert.deepEqual(readRolePolicy(env), {
            kind: "policy",
            policy: { role: "scout", writes: false, actions: { git: ["status"] }, ask: {} },
        });
        // Not even a name that agents.env lists lets the parent's value through when there is nothing to set.
        const bare = childEnvironment({ [ROLE_POLICY_VARIABLE]: "the parent's own" }, [ROLE_POLICY_VARIABLE], who);
        assert.equal(ROLE_POLICY_VARIABLE in bare, false);
    });
});

describe("the model", () => {
    const settings = (roles: Record<string, unknown>) => settingsFrom({ roles });
    const parent = { provider: "pp", id: "parent-model", thinking: "medium" };

    test("the role's model from configuration wins, with its thinking level", () => {
        assert.deepEqual(chooseModel(settings({ scout: { model: "a/b:low" } }), "scout", parent, undefined), {
            model: "a/b",
            thinking: "low",
            source: "role",
        });
    });

    test("without one, the child runs the parent's model and thinking level", () => {
        assert.deepEqual(chooseModel(settings({}), "scout", parent, ["x/*"]), {
            model: "pp/parent-model",
            thinking: "medium",
            source: "parent",
        });
        assert.equal(chooseModel(settings({}), "scout", undefined, undefined), undefined);
    });

    test("the thinking level, strongest first: the role's setting, the configured model's :level, the file's, the parent's", () => {
        const choose = (roleSettings: Record<string, unknown>, fileThinking?: string, withParent = true) =>
            chooseModel(
                settings({ scout: roleSettings }),
                "scout",
                withParent ? parent : undefined,
                undefined,
                fileThinking,
            )?.thinking;
        // A configured model.
        assert.equal(choose({ model: "a/b:low", thinking: "high" }, "minimal"), "high");
        assert.equal(choose({ model: "a/b:low" }, "minimal"), "low");
        assert.equal(choose({ model: "a/b" }, "minimal"), "minimal");
        assert.equal(choose({ model: "a/b" }), undefined, "Pi's own level for that model");
        // The parent's model, which carries the parent's level unless the role says another.
        assert.equal(choose({ thinking: "high" }, "minimal"), "high");
        assert.equal(choose({}, "minimal"), "minimal");
        assert.equal(choose({}), "medium");
    });

    test("a model outside enabledModels is refused with the allowed patterns; an empty list allows nothing", () => {
        assert.throws(
            () => chooseModel(settings({ scout: { model: "a/b" } }), "scout", parent, ["c/*", "d"]),
            (error: Error) => error instanceof StartError && /allowed: c\/\*, d/.test(error.message),
        );
        assert.throws(
            () => chooseModel(settings({ scout: { model: "a/b" } }), "scout", parent, []),
            /the list is empty/,
        );
        assert.ok(chooseModel(settings({ scout: { model: "a/b" } }), "scout", parent, ["a/*"]));
    });

    test("patterns: exact, glob over provider/id or id, a part of the name, with or without :thinking, case aside", () => {
        assert.ok(patternAllows("a/b", "a", "b"));
        assert.ok(patternAllows("a/*", "a", "anything"));
        assert.ok(patternAllows("*sonnet*", "x", "claude-sonnet-4"));
        assert.ok(patternAllows("claude-sonnet", "x", "claude-sonnet-4"));
        assert.ok(patternAllows("a/b:high", "a", "b"));
        assert.ok(patternAllows("A/B", "a", "b"));
        assert.ok(!patternAllows("a/b", "a", "c"));
        assert.ok(!patternAllows("a/*", "b", "x"));
        assert.ok(!patternAllows("opus", "x", "sonnet"));
    });

    test("enabledModels is read from Pi's global settings.json; a missing file or setting means no list", (t) => {
        const dir = mkdtempSync(path.join(tmpdir(), "jig-agents-settings-"));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        assert.equal(readEnabledModels(dir), undefined);
        writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ theme: "x" }));
        assert.equal(readEnabledModels(dir), undefined);
        writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledModels: ["a/*", 5, "b"] }));
        assert.deepEqual(readEnabledModels(dir), ["a/*", "b"]);
        writeFileSync(path.join(dir, "settings.json"), "{ not json");
        assert.throws(() => readEnabledModels(dir), /cannot be read/);
        writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledModels: "a" }));
        assert.throws(() => readEnabledModels(dir), /must be a list/);
    });
});

describe("which Pi", () => {
    test("is this process's own Node and Pi's entry file, found through a link, not whichever pi comes first on PATH", (t) => {
        const root = mkdtempSync(path.join(tmpdir(), "jig-agents-pi-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const pkg = path.join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
        mkdirSync(path.join(pkg, "dist", "bundle"), { recursive: true });
        writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
        writeFileSync(path.join(pkg, "dist", "bundle", "cli.js"), "");
        mkdirSync(path.join(root, "bin"));
        symlinkSync(path.join(pkg, "dist", "bundle", "cli.js"), path.join(root, "bin", "pi"));
        const entry = path.join(pkg, "dist", "bundle", "cli.js");
        assert.deepEqual(thisPi(["node", path.join(root, "bin", "pi")], "/usr/bin/node"), {
            file: "/usr/bin/node",
            args: [realpathSync(entry)],
        });
    });

    test("a compiled Pi with no entry file is started by its executable alone", () => {
        assert.deepEqual(thisPi(["/usr/bin/pi"], "/usr/bin/pi"), { file: "/usr/bin/pi", args: [] });
        assert.deepEqual(thisPi(["pi", "/$bunfs/root/pi"], "/usr/bin/pi"), { file: "/usr/bin/pi", args: [] });
    });

    test("a script that is not inside Pi's package is not taken for Pi's entry file", (t) => {
        const dir = mkdtempSync(path.join(tmpdir(), "jig-agents-notpi-"));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "something-else" }));
        writeFileSync(path.join(dir, "run.js"), "");
        assert.deepEqual(thisPi(["node", path.join(dir, "run.js")], "/usr/bin/node"), {
            file: "/usr/bin/node",
            args: [],
        });
    });
});

test("a role file parses into a role the flags can use", () => {
    const parsed = parseRole("---\nname: x\ndescription: d\ntools: read\nwrites: false\n---\nbody\n", "/x.md", "x");
    assert.equal(parsed.name, "x");
});
