// A workflow file, checked: every field, every rejection with the key at fault, and the three examples that ship.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
    callText,
    CONDITIONS,
    isCondition,
    parseCall,
    parseWorkflow,
    REPOSITORY_CONDITIONS,
} from "../src/definition.ts";

const EXAMPLES = path.resolve(import.meta.dirname, "../examples");

/** A valid workflow with the given parts replaced. */
function file(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
        name: "feature",
        description: "A change",
        match: { ticket: "^PROJ-\\d+$" },
        branch: "feature/{ticket}",
        stages: [{ id: "plan", goal: "Write the plan", exit: ["plan-approved"] }, { id: "done" }],
        holds: [{ until: "plan-approved", calls: ["git push", "write"] }],
        ...over,
    });
}

function errorsOf(over: Record<string, unknown>, name = "feature"): string[] {
    return parseWorkflow(file(over), name).errors;
}

describe("a valid workflow", () => {
    test("is read as written, with defaults for what is left out", () => {
        const { workflow, errors } = parseWorkflow(file(), "feature");
        assert.deepEqual(errors, []);
        assert.equal(workflow?.name, "feature");
        assert.equal(workflow?.branch, "feature/{ticket}");
        assert.equal(workflow?.match, "^PROJ-\\d+$");
        assert.deepEqual(workflow?.stages, [
            { id: "plan", goal: "Write the plan", exit: ["plan-approved"] },
            { id: "done", exit: [] },
        ]);
        assert.deepEqual(workflow?.holds, [
            { until: "plan-approved", calls: [{ tool: "git", action: "push" }, { tool: "write" }] },
        ]);

        const bare = parseWorkflow(JSON.stringify({ name: "x", stages: [{ id: "only" }] }), "x");
        assert.deepEqual(bare.errors, []);
        assert.equal(bare.workflow?.branch, "{ticket}");
        assert.deepEqual(bare.workflow?.holds, []);
        assert.equal(bare.workflow?.match, undefined);
    });

    test("the eight conditions, and the four that are about each repository", () => {
        assert.equal(CONDITIONS.length, 8);
        assert.deepEqual([...REPOSITORY_CONDITIONS].sort(), [
            "checks-pass",
            "pull-request-open",
            "review-done",
            "tests-pass-at-head",
        ]);
        assert.equal(isCondition("plan-approved"), true);
        assert.equal(isCondition("Plan-approved"), false);
        assert.equal(isCondition(3), false);
    });
});

describe("a file that is rejected says where", () => {
    test("something that is not JSON, or not an object", () => {
        assert.match(parseWorkflow("{ nope", "x").errors[0] ?? "", /^not valid JSON/);
        assert.deepEqual(parseWorkflow("[]", "x").errors, ["the file must hold one JSON object"]);
        assert.deepEqual(parseWorkflow("null", "x").errors, ["the file must hold one JSON object"]);
    });

    test("a field nobody defined, in the file, a stage, a hold and match", () => {
        const errors = errorsOf({
            colour: "red",
            match: { ticket: "^A$", flag: 1 },
            stages: [{ id: "a", exit: [], timeout: 5 }],
            holds: [{ until: "plan-approved", calls: ["write"], why: "x" }],
        });
        assert.deepEqual(errors.sort(), [
            "colour: unknown field",
            "holds[0].why: unknown field",
            "match.flag: unknown field",
            "stages[0].timeout: unknown field",
        ]);
    });

    test("a name that is odd, or not the file's", () => {
        assert.match(errorsOf({ name: "has space" }, "has space")[0] ?? "", /^name: must be letters, digits and -/);
        assert.match(errorsOf({ name: 3 })[0] ?? "", /^name:/);
        assert.match(errorsOf({ name: "other" })[0] ?? "", /^name: is "other", and the file is called "feature.json"/);
    });

    test("a description, match and branch of the wrong kind", () => {
        assert.match(errorsOf({ description: 3 })[0] ?? "", /^description:/);
        assert.match(errorsOf({ match: "PROJ" })[0] ?? "", /^match: must be an object/);
        assert.match(errorsOf({ match: {} })[0] ?? "", /^match.ticket: must be a regular expression/);
        assert.match(errorsOf({ match: { ticket: "(" } })[0] ?? "", /^match.ticket: not a regular expression/);
        assert.match(errorsOf({ branch: "feature" })[0] ?? "", /^branch: must be text with \{ticket\} in it/);
        assert.match(errorsOf({ branch: 4 })[0] ?? "", /^branch:/);
    });

    test("stages: none, a wrong kind, a bad or repeated id, a bad goal, a condition that does not exist", () => {
        assert.match(errorsOf({ stages: [] })[0] ?? "", /^stages: must be a list with at least one stage/);
        assert.match(errorsOf({ stages: "plan" })[0] ?? "", /^stages:/);
        assert.match(errorsOf({ stages: ["plan"] })[0] ?? "", /^stages\[0\]: must be an object with an id/);
        assert.match(errorsOf({ stages: [{ id: "Plan" }] })[0] ?? "", /^stages\[0\].id: must be lower-case/);
        assert.match(
            errorsOf({ stages: [{ id: "a" }, { id: "a" }] })[0] ?? "",
            /^stages\[1\].id: "a" is used by an earlier stage/,
        );
        assert.match(errorsOf({ stages: [{ id: "a", goal: 3 }] })[0] ?? "", /^stages\[0\].goal:/);
        assert.match(
            errorsOf({ stages: [{ id: "a", exit: "plan-approved" }] })[0] ?? "",
            /^stages\[0\].exit: must be a list/,
        );
        assert.match(
            errorsOf({ stages: [{ id: "a", exit: ["plan-approved", "tests-pass"] }] })[0] ?? "",
            /^stages\[0\].exit\[1\]: "tests-pass" is not a condition \(notes-updated, plan-approved/,
        );
        assert.match(
            errorsOf({ stages: [{ id: "a", exit: ["plan-approved", "plan-approved"] }] })[0] ?? "",
            /^stages\[0\].exit\[1\]: "plan-approved" is listed twice/,
        );
    });

    test("holds: a wrong kind, a condition that does not exist, calls that are not tool names", () => {
        assert.match(errorsOf({ holds: {} })[0] ?? "", /^holds: must be a list/);
        assert.match(errorsOf({ holds: ["x"] })[0] ?? "", /^holds\[0\]: must be an object/);
        assert.match(
            errorsOf({ holds: [{ until: "later", calls: ["write"] }] })[0] ?? "",
            /^holds\[0\].until: "later" is not a condition/,
        );
        assert.match(
            errorsOf({ holds: [{ until: "plan-approved" }] })[0] ?? "",
            /^holds\[0\].calls: must be a list with at least one call/,
        );
        assert.match(errorsOf({ holds: [{ until: "plan-approved", calls: [] }] })[0] ?? "", /^holds\[0\].calls:/);
        for (const call of ["", "git push now", "git  push", "rm -rf /", 3, "git;push"]) {
            assert.match(
                errorsOf({ holds: [{ until: "plan-approved", calls: [call] }] })[0] ?? "",
                /^holds\[0\].calls\[0\]: .* must be a tool name, alone or with one action/,
                JSON.stringify(call),
            );
        }
    });

    test("every problem is listed, not only the first", () => {
        assert.ok(errorsOf({ branch: "x", stages: [], holds: 1, colour: 2 }).length >= 4);
    });

    test("an error never holds control characters from the file", () => {
        const errors = errorsOf({ stages: [{ id: "a", exit: ["bad\u001b[31m\ncondition"] }] });
        assert.ok(errors.every((error) => !/[\u0000-\u001f]/.test(error)));
    });
});

describe("a hold's call", () => {
    test("a tool alone, or a tool and one action", () => {
        assert.deepEqual(parseCall("write"), { tool: "write" });
        assert.deepEqual(parseCall("git push"), { tool: "git", action: "push" });
        assert.equal(parseCall(""), undefined);
        assert.equal(parseCall("git push now"), undefined);
        assert.equal(callText({ tool: "git", action: "push" }), "git push");
        assert.equal(callText({ tool: "edit" }), "edit");
    });
});

describe("the examples that ship", () => {
    const names = readdirSync(EXAMPLES)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .sort();

    test("there are three: feature, bugfix and investigation", () => {
        assert.deepEqual(names, ["bugfix", "feature", "investigation"]);
    });

    for (const name of ["feature", "bugfix", "investigation"]) {
        test(`${name}.json passes every check`, () => {
            const parsed = parseWorkflow(readFileSync(path.join(EXAMPLES, `${name}.json`), "utf8"), name);
            assert.deepEqual(parsed.errors, []);
            assert.ok(parsed.workflow !== undefined);
        });
    }

    test("they say what the docs say they say", () => {
        const load = (name: string) =>
            parseWorkflow(readFileSync(path.join(EXAMPLES, `${name}.json`), "utf8"), name).workflow;
        const feature = load("feature");
        assert.deepEqual(
            feature?.stages.map((stage) => stage.id),
            ["understand", "plan", "build", "review", "deliver", "accept", "done"],
        );
        assert.deepEqual(feature?.stages.find((stage) => stage.id === "deliver")?.exit, [
            "pull-request-open",
            "checks-pass",
        ]);
        assert.deepEqual(feature?.stages.find((stage) => stage.id === "accept")?.exit, [
            "scenarios-pass",
            "you-approve",
        ]);
        assert.deepEqual(
            feature?.holds.map((hold) => hold.until),
            ["plan-approved", "tests-pass-at-head"],
        );
        assert.deepEqual(
            load("bugfix")?.stages.map((stage) => stage.id),
            ["reproduce", "fix", "verify", "done"],
        );
        assert.deepEqual(
            load("investigation")?.stages.map((stage) => stage.id),
            ["gather", "explain", "done"],
        );
        assert.deepEqual(load("investigation")?.holds, []);
    });

    test("they are generic: a ticket pattern of the PROJ-123 kind and no company in them", () => {
        for (const name of names) {
            const text = readFileSync(path.join(EXAMPLES, `${name}.json`), "utf8");
            assert.doesNotMatch(text, /https?:\/\/|@[a-z]+\.[a-z]/i, name);
        }
        const feature = parseWorkflow(readFileSync(path.join(EXAMPLES, "feature.json"), "utf8"), "feature").workflow;
        assert.equal(new RegExp(feature?.match ?? "$^").test("PROJ-123"), true);
        assert.equal(new RegExp(feature?.match ?? "$^").test("PROJ-"), false);
    });
});
