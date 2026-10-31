// The `agents` section: every field checked with the key named, unknown fields refused, defaults filled in, and a role's limits laid over
// the general ones.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    approvalsFor,
    DEFAULT_LIMITS,
    limitsFor,
    parseModel,
    SECTION_FIELDS,
    settingsFrom,
    validateAgents,
} from "../src/config.ts";

describe("validateAgents", () => {
    test("an empty section is valid, and so is a full one", () => {
        assert.deepEqual(validateAgents({}), []);
        assert.deepEqual(
            validateAgents({
                roles: {
                    scout: {
                        model: "provider/small-model:low",
                        maxTurns: 30,
                        maxMinutes: 10,
                        maxCost: 0.5,
                        approvals: "deny",
                    },
                },
                limits: { maxTurns: 40, maxMinutes: 30, maxCost: 2 },
                approvals: "forward",
                maxRunning: 4,
                maxStarted: 30,
                approvalWaitMinutes: 30,
                maxAsks: 10,
                folders: ["/opt/roles", "~/roles"],
                env: ["MODEL_API_KEY"],
                branch: "agent/{name}",
            }),
            [],
        );
    });

    test("an unknown field is an error that names it, at every level", () => {
        assert.deepEqual(validateAgents({ colour: 1 }), ["agents.colour: unknown field"]);
        assert.deepEqual(validateAgents({ limits: { maxTokens: 5 } }), ["agents.limits.maxTokens: unknown field"]);
        assert.deepEqual(validateAgents({ roles: { scout: { extensions: false } } }), [
            "agents.roles.scout.extensions: unknown field",
        ]);
    });

    test("every number has its range, and there is no 'no limit'", () => {
        const bad = (section: unknown) => validateAgents(section).length;
        for (const section of [
            { limits: { maxTurns: 0 } },
            { limits: { maxTurns: 501 } },
            { limits: { maxTurns: 2.5 } },
            { limits: { maxMinutes: 0 } },
            { limits: { maxMinutes: 481 } },
            { limits: { maxCost: 0 } },
            { limits: { maxCost: -1 } },
            { limits: { maxCost: 101 } },
            { limits: { maxCost: "unlimited" } },
            { limits: { maxTurns: null } },
            { limits: { maxTurns: Number.POSITIVE_INFINITY } },
            { maxRunning: 0 },
            { maxRunning: 17 },
            { maxStarted: 201 },
            { approvalWaitMinutes: 0 },
            { approvalWaitMinutes: 241 },
            { maxAsks: -1 },
            { maxAsks: 101 },
            { roles: { scout: { maxCost: 0 } } },
        ]) {
            assert.equal(bad(section), 1, JSON.stringify(section));
        }
        for (const section of [
            { limits: { maxCost: 0.01 } },
            { limits: { maxCost: 100 } },
            { maxAsks: 0 },
            { maxAsks: 100 },
            { maxRunning: 16 },
        ]) {
            assert.equal(bad(section), 0, JSON.stringify(section));
        }
    });

    test("the model is provider/id with an optional thinking level, and a role name is a word", () => {
        assert.equal(validateAgents({ roles: { scout: { model: "small" } } }).length, 1);
        assert.equal(validateAgents({ roles: { scout: { model: "a b/c" } } }).length, 1);
        assert.equal(validateAgents({ roles: { scout: { model: "/id" } } }).length, 1);
        assert.equal(validateAgents({ roles: { "my role": {} } }).length, 1);
        assert.deepEqual(validateAgents({ roles: { scout: { model: "cloud/vendor.model-v2:0" } } }), []);
    });

    test("approvals are forward or deny; folders are absolute or home-relative; env holds variable names", () => {
        assert.equal(validateAgents({ approvals: "allow" }).length, 1);
        assert.equal(validateAgents({ roles: { scout: { approvals: "sometimes" } } }).length, 1);
        assert.equal(validateAgents({ folders: ["relative/path"] }).length, 1);
        assert.equal(validateAgents({ folders: "/x" }).length, 1);
        assert.equal(validateAgents({ env: ["BAD NAME"] }).length, 1);
        assert.equal(validateAgents({ env: ["1ABC"] }).length, 1);
        assert.equal(validateAgents({ env: "PATH" }).length, 1);
    });

    test("a role's actions, ask, skills, preload, context and thinking are accepted when they are well formed", () => {
        assert.deepEqual(
            validateAgents({
                roles: {
                    scout: {
                        actions: { git: ["status", "log"], jira: [] },
                        ask: { git: ["push"] },
                        skills: ["git", "house-style"],
                        preload: ["git"],
                        context: "none",
                        thinking: "high",
                    },
                    reviewer: { skills: "none", context: "project", thinking: "off" },
                },
            }),
            [],
        );
    });

    test("actions and ask are an object from a tool to a list of action names; ask needs at least one", () => {
        const bad = (field: string, value: unknown) => validateAgents({ roles: { scout: { [field]: value } } });
        assert.match(
            bad("actions", ["git"])[0] ?? "",
            /agents\.roles\.scout\.actions: must be an object from a tool to its actions/,
        );
        assert.match(bad("actions", { git: "status" })[0] ?? "", /actions\.git: must be a list of actions/);
        assert.match(bad("actions", { git: [3] })[0] ?? "", /actions\.git: every action must be a name/);
        assert.match(bad("actions", { git: ["no spaces"] })[0] ?? "", /every action must be a name/);
        assert.match(bad("actions", { "bad tool": ["x"] })[0] ?? "", /"bad tool" is not a tool name/);
        assert.match(bad("ask", { git: [] })[0] ?? "", /ask\.git: must be a list of one or more actions/);
        assert.match(bad("ask", "git push")[0] ?? "", /agents\.roles\.scout\.ask: must be an object/);
    });

    test("skills is none or a list of skill names, preload a list, context project or none, thinking one of Pi's levels", () => {
        const bad = (field: string, value: unknown) => validateAgents({ roles: { scout: { [field]: value } } });
        assert.match(
            bad("skills", "all")[0] ?? "",
            /agents\.roles\.scout\.skills: must be a list of one to 30 skill names/,
        );
        assert.match(bad("skills", [])[0] ?? "", /skills: must be a list of one to 30/);
        assert.match(
            bad("skills", ["Git"])[0] ?? "",
            /skills: every skill name is lowercase letters, digits and hyphens/,
        );
        assert.match(bad("preload", "git")[0] ?? "", /preload: must be a list of one to 10 skill names/);
        assert.match(bad("preload", ["a_b"])[0] ?? "", /preload: every skill name/);
        assert.match(bad("context", "some")[0] ?? "", /context: must be "project" or "none"/);
        assert.match(bad("thinking", "deep")[0] ?? "", /thinking: must be one of off, minimal/);
        assert.match(bad("thinking", 3)[0] ?? "", /thinking: must be one of/);
    });

    test("writes, tools, description, prompt and name are not settings: they are the agent file's, and the error says so", () => {
        for (const field of ["writes", "tools", "description", "prompt", "name"]) {
            const errors = validateAgents({ roles: { scout: { [field]: true } } });
            assert.equal(errors.length, 1, field);
            assert.match(errors[0] ?? "", new RegExp(`agents\\.roles\\.scout\\.${field}: `));
            assert.doesNotMatch(errors[0] ?? "", /unknown field/);
        }
        // Anything else is still an unknown field.
        assert.deepEqual(validateAgents({ roles: { scout: { memory: "project" } } }), [
            "agents.roles.scout.memory: unknown field",
        ]);
    });

    test("a branch pattern must hold {name} and be a plausible branch name", () => {
        for (const branch of [
            "agent",
            "agent/{name}/",
            "agent/../{name}",
            "-x/{name}",
            "agent/{name}.lock",
            "agent//{name}",
            5,
        ]) {
            assert.equal(validateAgents({ branch }).length, 1, String(branch));
        }
        assert.deepEqual(validateAgents({ branch: "work/agents/{name}" }), []);
    });

    test("a section that is not an object is an error", () => {
        assert.deepEqual(validateAgents([]), ["agents: must be an object"]);
        assert.deepEqual(validateAgents("x"), ["agents: must be an object"]);
        assert.deepEqual(validateAgents({ roles: [] }), [
            "agents.roles: must be an object from a role name to its settings",
        ]);
    });
});

describe("settingsFrom", () => {
    test("gives the design's defaults for an absent or invalid section", () => {
        for (const section of [undefined, {}, { colour: 1 }]) {
            const s = settingsFrom(section, "/home/me");
            assert.deepEqual(s.limits, { maxTurns: 40, maxMinutes: 30, maxCost: 2 });
            assert.equal(s.approvals, "forward");
            assert.deepEqual([s.maxRunning, s.maxStarted, s.approvalWaitMinutes, s.maxAsks], [4, 30, 30, 10]);
            assert.deepEqual(s.folders, []);
            assert.deepEqual(s.env, []);
            assert.equal(s.branch, "agent/{name}");
        }
        assert.deepEqual(DEFAULT_LIMITS, { maxTurns: 40, maxMinutes: 30, maxCost: 2 });
    });

    test("keeps a role's actions, ask, skills, preload, context and thinking, as copies", () => {
        const section = {
            roles: {
                scout: {
                    actions: { git: ["status", "status", "log"] },
                    ask: { git: ["push"] },
                    skills: ["git"],
                    preload: ["git"],
                    context: "none",
                    thinking: "low",
                },
                reviewer: { skills: "none" },
            },
        };
        const s = settingsFrom(section, "/home/me");
        assert.deepEqual(s.roles.scout, {
            actions: { git: ["status", "log"] },
            ask: { git: ["push"] },
            skills: ["git"],
            preload: ["git"],
            context: "none",
            thinking: "low",
        });
        assert.equal(s.roles.reviewer?.skills, "none");
        const copy = s.roles.scout?.skills;
        assert.ok(Array.isArray(copy));
        copy.push("changed");
        assert.deepEqual(section.roles.scout.skills, ["git"]);
    });

    test("reads the fields, expanding ~/ in folders", () => {
        const s = settingsFrom(
            {
                roles: { scout: { model: "p/m:low", maxTurns: 3 } },
                limits: { maxMinutes: 7 },
                maxAsks: 3,
                folders: ["~/roles", "/abs"],
                env: ["K"],
                branch: "w/{name}",
            },
            "/home/me",
        );
        assert.equal(s.roles.scout?.model, "p/m:low");
        assert.equal(s.limits.maxMinutes, 7);
        assert.equal(s.limits.maxTurns, 40);
        assert.equal(s.maxAsks, 3);
        assert.deepEqual(s.folders, ["/home/me/roles", "/abs"]);
        assert.deepEqual(s.env, ["K"]);
        assert.equal(s.branch, "w/{name}");
    });

    test("a role's limits and approvals win over the general ones", () => {
        const s = settingsFrom({
            limits: { maxTurns: 10 },
            approvals: "deny",
            roles: { scout: { maxTurns: 3, approvals: "forward" } },
        });
        assert.deepEqual(limitsFor(s, "scout"), { maxTurns: 3, maxMinutes: 30, maxCost: 2 });
        assert.deepEqual(limitsFor(s, "worker"), { maxTurns: 10, maxMinutes: 30, maxCost: 2 });
        assert.equal(approvalsFor(s, "scout"), "forward");
        assert.equal(approvalsFor(s, "worker"), "deny");
    });
});

describe("parseModel", () => {
    test("splits provider, id and thinking, and keeps a colon that belongs to the id", () => {
        assert.deepEqual(parseModel("anthropic/claude-sonnet:high"), {
            model: "anthropic/claude-sonnet",
            provider: "anthropic",
            id: "claude-sonnet",
            thinking: "high",
        });
        assert.deepEqual(parseModel("cloud/vendor.model-v2:0"), {
            model: "cloud/vendor.model-v2:0",
            provider: "cloud",
            id: "vendor.model-v2:0",
        });
        assert.equal(parseModel("nothing"), undefined);
        assert.equal(parseModel(""), undefined);
    });
});

test("SECTION_FIELDS lists the top-level fields", () => {
    assert.equal(new Set(SECTION_FIELDS).size, SECTION_FIELDS.length);
    assert.ok(SECTION_FIELDS.includes("roles") && SECTION_FIELDS.includes("branch"));
});
