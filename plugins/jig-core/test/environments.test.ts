// Environments: the built-in names, the names a company adds, and the rule that an unknown name is production.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildEnvironments } from "../src/environments.ts";

describe("environment kinds", () => {
    const { environments } = buildEnvironments([
        {
            source: "company",
            origin: "company",
            environments: { staging: { kind: "test" }, qa: { kind: "test", mask: true }, prod: { kind: "production" } },
        },
    ]);

    test("the built-in names", () => {
        assert.equal(environments.kindOf("local"), "local");
        assert.equal(environments.kindOf("external"), "external");
        assert.equal(environments.kindOf("production"), "production");
    });

    test("configured names have the kind they were given", () => {
        assert.equal(environments.kindOf("staging"), "test");
        assert.equal(environments.kindOf("qa"), "test");
        assert.equal(environments.kindOf("prod"), "production");
    });

    test("an unknown name counts as production, to fail safe", () => {
        assert.equal(environments.kindOf("nowhere"), "production");
        assert.equal(environments.kindOf(""), "production");
        // Case matters: a name that differs only in case was not defined.
        assert.equal(environments.kindOf("Staging"), "production");
        assert.equal(environments.kindOf("LOCAL"), "production");
        // Names that look like object internals are just unknown names.
        assert.equal(environments.kindOf("constructor"), "production");
        assert.equal(environments.kindOf("__proto__"), "production");
    });

    test("which names are known", () => {
        assert.equal(environments.isKnown("local"), true);
        assert.equal(environments.isKnown("staging"), true);
        assert.equal(environments.isKnown("nowhere"), false);
        assert.equal(environments.isKnown("toString"), false);
        assert.deepEqual(environments.names(), ["local", "external", "production", "staging", "qa", "prod"]);
    });
});

describe("the list of environments", () => {
    test("the built-in names come first, then each defined name with its kind and who defined it", () => {
        const { environments } = buildEnvironments([
            {
                source: "company",
                origin: "company",
                environments: { staging: { kind: "test" }, prod: { kind: "production" } },
            },
            { source: "/home/me/jig.json", origin: "personal", environments: { sandbox: { kind: "test" } } },
        ]);
        assert.deepEqual(environments.list(), [
            { name: "local", kind: "local", source: "built-in" },
            { name: "external", kind: "external", source: "built-in" },
            { name: "production", kind: "production", source: "built-in" },
            { name: "staging", kind: "test", source: "company" },
            { name: "prod", kind: "production", source: "company" },
            { name: "sandbox", kind: "test", source: "personal" },
        ]);
    });

    test("a name both define is listed once, under whoever set its kind", () => {
        const { environments } = buildEnvironments([
            { source: "company", origin: "company", environments: { a: { kind: "test" }, b: { kind: "test" } } },
            {
                source: "/home/me/jig.json",
                origin: "personal",
                environments: { a: { kind: "test", mask: true }, b: { kind: "production" } },
            },
        ]);
        const defined = environments.list().filter((entry) => entry.source !== "built-in");
        assert.deepEqual(defined, [
            { name: "a", kind: "test", source: "company" },
            { name: "b", kind: "production", source: "personal" },
        ]);
    });

    test("a refused definition is not listed, and a name nobody defined is not either", () => {
        const { environments } = buildEnvironments([
            {
                source: "/home/me/jig.json",
                origin: "personal",
                environments: { local: { kind: "production" } },
            },
        ]);
        assert.deepEqual(
            environments.list().map((entry) => entry.name),
            ["local", "external", "production"],
        );
        assert.equal(environments.list().find((entry) => entry.name === "local")?.kind, "local");
    });
});

describe("masking", () => {
    const { environments } = buildEnvironments([
        {
            source: "company",
            origin: "company",
            environments: { staging: { kind: "test" }, qa: { kind: "test", mask: true }, prod: { kind: "production" } },
        },
    ]);

    test("production is always masked, and so is a name nobody defined", () => {
        assert.equal(environments.masks("production"), true);
        assert.equal(environments.masks("prod"), true);
        assert.equal(environments.masks("nowhere"), true);
    });

    test("a test environment is masked only when it says mask: true", () => {
        assert.equal(environments.masks("qa"), true);
        assert.equal(environments.masks("staging"), false);
    });

    test("local and external are not masked", () => {
        assert.equal(environments.masks("local"), false);
        assert.equal(environments.masks("external"), false);
    });
});

describe("layers", () => {
    test("a later layer can add a mask, but never remove one or lower production", () => {
        const merged = buildEnvironments([
            {
                source: "company",
                origin: "company",
                environments: { a: { kind: "test", mask: true }, b: { kind: "production" } },
            },
            {
                source: "personal",
                origin: "personal",
                environments: {
                    a: { kind: "test", mask: false },
                    b: { kind: "test" },
                    c: { kind: "test", mask: true },
                },
            },
        ]);
        assert.equal(merged.environments.masks("a"), true, "the mask stays");
        assert.equal(merged.environments.kindOf("b"), "production", "production stays");
        assert.equal(merged.environments.masks("c"), true);
        assert.equal(merged.problems.length, 1);
        assert.equal(merged.problems[0]?.source, "personal");
        assert.equal(merged.problems[0]?.key, "environments.b.kind");
    });

    test("a later layer can make a test environment production", () => {
        const merged = buildEnvironments([
            { source: "company", origin: "company", environments: { x: { kind: "test" } } },
            { source: "personal", origin: "personal", environments: { x: { kind: "production" } } },
        ]);
        assert.equal(merged.environments.kindOf("x"), "production");
        assert.equal(merged.environments.masks("x"), true);
        assert.deepEqual(merged.problems, []);
    });

    test("the built-in names cannot be redefined", () => {
        const merged = buildEnvironments([
            {
                source: "personal",
                origin: "personal",
                environments: { local: { kind: "production" }, external: { kind: "test" } },
            },
        ]);
        assert.equal(merged.problems.length, 2);
        assert.equal(merged.environments.kindOf("local"), "local");
        assert.equal(merged.environments.kindOf("external"), "external");
    });
});
