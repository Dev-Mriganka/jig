// Configuration: what loads, what is an error, and what can never lower the floor.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
    addCompanyClassifyRules, addCompanyEnvironments, addCompanyRules, buildPolicy, defaultConfig, describeProblem,
    emptyAdditions, floorViolation, loadConfigFile, parseConfig,
} from "../src/config.ts";
import type { LoadedConfig } from "../src/config.ts";
import { buildEnvironments } from "../src/environments.ts";
import type { Rule } from "../src/contract.ts";

const FILE = "/somewhere/jig.json";

/** A loaded personal config, as `loadConfigFile` would return it for a valid file. */
function personal(value: unknown): LoadedConfig {
    return { file: FILE, found: true, ...parseConfig(value, FILE) };
}

describe("loading the file", () => {
    let dir: string;
    before(() => { dir = mkdtempSync(path.join(tmpdir(), "jig-config-")); });
    after(() => rmSync(dir, { recursive: true, force: true }));

    test("no file means the defaults, and that is not an error", () => {
        const loaded = loadConfigFile(path.join(dir, "missing.json"));
        assert.equal(loaded.found, false);
        assert.deepEqual(loaded.problems, []);
        assert.deepEqual(loaded.config, defaultConfig());
        assert.deepEqual(loaded.config.secrets.backends, ["pass"]);
        assert.equal(loaded.config.records.retentionDays, 90);
        assert.equal(loaded.config.spill.retentionDays, 7);
    });

    test("a valid file loads, with a byte-order mark tolerated", () => {
        const file = path.join(dir, "valid.json");
        writeFileSync(file, `﻿${JSON.stringify({
            environments: { staging: { kind: "test", mask: true }, prod: { kind: "production" } },
            rules: [{ tool: "git", action: "push", decision: "ask", approval: "review" }],
            classify: [{ tool: "other_db", param: "target", value: "live", environment: "prod", effect: "read" }],
            secrets: { backends: ["pass", "env"] },
            records: { retentionDays: 30 },
            spill: { retentionDays: 3 },
        })}`);
        const loaded = loadConfigFile(file);
        assert.deepEqual(loaded.problems, []);
        assert.equal(loaded.config.environments.staging?.mask, true);
        assert.equal(loaded.config.rules[0]?.approval, "review");
        assert.equal(loaded.config.classify[0]?.value, "live");
        assert.deepEqual(loaded.config.secrets.backends, ["pass", "env"]);
        assert.equal(loaded.config.records.retentionDays, 30);
        assert.equal(loaded.config.spill.retentionDays, 3);
    });

    test("invalid JSON is an error that names the file and does not quote the text", () => {
        const file = path.join(dir, "broken.json");
        writeFileSync(file, '{ "rules": [ SECRET-LOOKING-TEXT');
        const loaded = loadConfigFile(file);
        assert.equal(loaded.problems.length, 1);
        assert.equal(loaded.problems[0]?.source, file);
        assert.ok(!describeProblem(loaded.problems[0]!).includes("SECRET-LOOKING-TEXT"));
        assert.deepEqual(loaded.config, defaultConfig());
    });
});

describe("an unknown field is an error", () => {
    test("at the top: the problem names the file and the key, and the defaults apply", () => {
        const loaded = personal({ rule: [{ tool: "x", decision: "deny" }], rules: [{ tool: "y", decision: "deny" }] });
        assert.equal(loaded.problems.length, 1);
        assert.deepEqual(loaded.problems[0], { source: FILE, key: "rule", message: "is not a known field" });
        assert.equal(describeProblem(loaded.problems[0]!), `${FILE}: rule: is not a known field`);
        // The defaults, not half of the file: the rules in the file are not used either.
        assert.deepEqual(loaded.config.rules, []);
    });

    test("inside a rule: the key says which rule and which field", () => {
        const loaded = personal({ rules: [{ tool: "a", decision: "allow" }, { tool: "b", decison: "deny" }] });
        const keys = loaded.problems.map((problem) => problem.key);
        assert.ok(keys.includes("rules[1].decison"), keys.join());
        assert.ok(keys.includes("rules[1].decision"), "the missing decision is reported as well");
        assert.deepEqual(loaded.config.rules, []);
    });

    test("in every nested section", () => {
        for (const [section, value] of [
            ["environments.qa.colour", { environments: { qa: { kind: "test", colour: "blue" } } }],
            ["classify[0].extra", { classify: [{ tool: "t", param: "p", value: "v", environment: "e", effect: "read", extra: 1 }] }],
            ["secrets.backend", { secrets: { backend: ["pass"] } }],
            ["records.keepDays", { records: { keepDays: 3 } }],
            ["spill.keepDays", { spill: { keepDays: 3 } }],
        ] as const) {
            const loaded = personal(value);
            assert.ok(loaded.problems.some((problem) => problem.key === section), `${section}: ${loaded.problems.map((p) => p.key).join()}`);
        }
    });

    test("a plugin's section is unknown until the plugin registers it (see sections.test.ts)", () => {
        const loaded = personal({ git: { anything: true }, rules: [{ tool: "t", decision: "ask" }] });
        assert.deepEqual(loaded.problems, [{ source: FILE, key: "git", message: "is not a known field" }]);
        assert.deepEqual(loaded.config.rules, []);
    });

    test("wrong types and values are errors too", () => {
        const bad = (value: unknown, key: string) => assert.ok(personal(value).problems.some((problem) => problem.key === key), key);
        bad({ rules: "all" }, "rules");
        bad({ rules: [{ tool: "t", decision: "maybe" }] }, "rules[0].decision");
        bad({ rules: [{ tool: "t", decision: "ask", approval: "popup" }] }, "rules[0].approval");
        bad({ rules: [{ tool: "t", decision: "ask", effect: "delete" }] }, "rules[0].effect");
        bad({ secrets: { backends: ["pass", "vault"] } }, "secrets.backends[1]");
        bad({ records: { retentionDays: 0 } }, "records.retentionDays");
        bad({ records: { retentionDays: 1.5 } }, "records.retentionDays");
        bad({ classify: [{ tool: "t", param: "p", environment: "e", effect: "read" }] }, "classify[0]");
        bad({ classify: [{ tool: "t", param: "p", value: "v", pattern: "x", environment: "e", effect: "read" }] }, "classify[0]");
        bad({ classify: [{ tool: "t", param: "p", pattern: "(", environment: "e", effect: "read" }] }, "classify[0].pattern");
        bad({ environments: { qa: { kind: "staging" } } }, "environments.qa.kind");
        bad([], "(file)");
    });

    test("production masking cannot be turned off, and the built-in environments cannot be redefined", () => {
        const masking = personal({ environments: { prod: { kind: "production", mask: false } } });
        assert.ok(masking.problems.some((problem) => problem.key === "environments.prod.mask"));
        const merged = buildEnvironments([{ source: FILE, environments: { production: { kind: "test" }, local: { kind: "production" } } }]);
        assert.equal(merged.problems.length, 2);
        assert.equal(merged.environments.kindOf("production"), "production");
        assert.equal(merged.environments.kindOf("local"), "local");
    });
});

describe("a rule that would lower the floor is refused, with the file and the key named", () => {
    const rule = (extra: Partial<Rule>): Rule => ({ tool: "deploy", decision: "allow", ...extra });

    function refusals(rules: Rule[], environments: Record<string, { kind: "test" | "production" }> = { prod: { kind: "production" }, qa: { kind: "test" } }) {
        return buildPolicy(personal({ environments, rules }), emptyAdditions());
    }

    test("allow or ask on a write to a production environment", () => {
        for (const decision of ["allow", "ask"] as const) {
            const policy = refusals([rule({ environment: "prod", effect: "write", decision })]);
            assert.deepEqual(policy.rules, [], decision);
            assert.equal(policy.problems.length, 1);
            assert.equal(policy.problems[0]?.source, FILE);
            assert.equal(policy.problems[0]?.key, "rules[0].decision");
            assert.match(describeProblem(policy.problems[0]!), /jig\.json: rules\[0\]\.decision: .*production writes.*always denied/);
        }
    });

    test("also when the rule does not say read or write, because it would cover writes", () => {
        const policy = refusals([rule({ environment: "prod" })]);
        assert.deepEqual(policy.rules, []);
        assert.match(policy.problems[0]?.message ?? "", /effect "read"/);
    });

    test("also for the built-in production name, and for a name nobody defined (it counts as production)", () => {
        assert.deepEqual(refusals([rule({ environment: "production", effect: "write" })]).rules, []);
        const unknown = refusals([rule({ environment: "nowhere", effect: "write" })]);
        assert.deepEqual(unknown.rules, []);
        assert.match(unknown.problems[0]?.message ?? "", /not a defined environment, so it counts as production/);
    });

    test("what is allowed: deny, a read, a test environment, and a rule that names no environment", () => {
        const kept = [
            rule({ environment: "prod", effect: "write", decision: "deny" }),
            rule({ environment: "prod", effect: "read", decision: "allow" }),
            rule({ environment: "prod", effect: "read", decision: "ask" }),
            rule({ environment: "qa", effect: "write", decision: "allow" }),
            rule({ effect: "write", decision: "allow" }),
        ];
        const policy = refusals(kept);
        assert.deepEqual(policy.problems, []);
        assert.equal(policy.rules.length, kept.length);
    });

    test("one refused rule does not take the others with it", () => {
        const policy = refusals([rule({ tool: "a", environment: "qa", decision: "allow" }), rule({ tool: "b", environment: "prod", effect: "write" }), rule({ tool: "c", decision: "deny" })]);
        assert.deepEqual(policy.rules.map((r) => r.tool), ["a", "c"]);
        assert.equal(policy.problems[0]?.key, "rules[1].decision");
    });

    test("floorViolation can be asked directly", () => {
        const { environments } = buildEnvironments([{ source: FILE, environments: { prod: { kind: "production" } } }]);
        assert.equal(floorViolation(rule({ environment: "local", effect: "write" }), environments), undefined);
        assert.notEqual(floorViolation(rule({ environment: "prod", effect: "write" }), environments), undefined);
    });
});

describe("environments from configuration", () => {
    test("a company environment cannot be lowered by the personal file, and a mask can be added", () => {
        const company = emptyAdditions();
        addCompanyEnvironments(company, { prod: { kind: "production" }, qa: { kind: "test" } });
        const policy = buildPolicy(personal({ environments: { prod: { kind: "test" }, qa: { kind: "test", mask: true } } }), company);
        assert.equal(policy.environments.kindOf("prod"), "production");
        assert.equal(policy.environments.masks("qa"), true);
        assert.ok(policy.problems.some((problem) => problem.source === FILE && problem.key === "environments.prod.kind"), JSON.stringify(policy.problems));
    });

    test("a personal file can make a company test environment production", () => {
        const company = emptyAdditions();
        addCompanyEnvironments(company, { qa: { kind: "test" } });
        const policy = buildPolicy(personal({ environments: { qa: { kind: "production" } } }), company);
        assert.equal(policy.environments.kindOf("qa"), "production");
        assert.deepEqual(policy.problems, []);
    });
});

describe("personal over company", () => {
    test("personal rules come first, so they win; the company's follow", () => {
        const company = emptyAdditions();
        addCompanyEnvironments(company, { staging: { kind: "test" } });
        addCompanyRules(company, [{ tool: "deploy", environment: "staging", decision: "allow" }, { tool: "other", decision: "ask" }]);
        const policy = buildPolicy(personal({ rules: [{ tool: "deploy", decision: "ask" }] }), company);
        assert.deepEqual(policy.rules.map((r) => `${r.tool}:${r.decision}`), ["deploy:ask", "deploy:allow", "other:ask"]);
    });

    test("classification rules follow the same order", () => {
        const company = emptyAdditions();
        addCompanyClassifyRules(company, [{ tool: "db", param: "t", value: "x", environment: "from-company", effect: "read" }]);
        const policy = buildPolicy(personal({ classify: [{ tool: "db", param: "t", value: "x", environment: "from-me", effect: "read" }] }), company);
        assert.deepEqual(policy.classify.map((r) => r.environment), ["from-me", "from-company"]);
    });

    test("a company rule that would lower the floor is refused too, as `company`", () => {
        const company = emptyAdditions();
        addCompanyEnvironments(company, { prod: { kind: "production" } });
        addCompanyRules(company, [{ tool: "t", environment: "prod", effect: "write", decision: "allow" }]);
        const policy = buildPolicy(personal({}), company);
        assert.deepEqual(policy.rules, []);
        assert.equal(policy.problems[0]?.source, "company");
        assert.equal(policy.problems[0]?.key, "rules[0].decision");
    });

    test("invalid company additions are reported, not thrown, and the valid ones stay", () => {
        const company = emptyAdditions();
        addCompanyRules(company, [{ tool: "ok", decision: "ask" }]);
        addCompanyRules(company, [{ tool: "bad", decision: "sometimes" }, { tool: "fine", decision: "deny" }]);
        assert.deepEqual(company.rules.map((r) => r.tool), ["ok", "fine"]);
        assert.equal(company.problems.length, 1);
        // The position counts the earlier call, so the key can be found in the plugin's own list.
        assert.equal(company.problems[0]?.key, "rules[1].decision");
        assert.equal(company.problems[0]?.source, "company");
    });
});
