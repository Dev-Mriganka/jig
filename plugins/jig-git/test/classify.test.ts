import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CallClass } from "../../jig-core/src/contract.ts";
import { CHECKS_ACTIONS } from "../src/checks.ts";
import { GIT_ACTIONS } from "../src/git.ts";
import { PR_ACTIONS } from "../src/pr.ts";
import { RELEASE_ACTIONS } from "../src/release.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(() => {
    h = setupHarness();
});
after(() => h.cleanup());

const classify = (tool: string, input: Record<string, unknown>): CallClass | undefined =>
    h.jig.declared.get(tool)?.classify(input);

type Row = [action: string, environment: string, effect: string, extra?: Partial<CallClass>];

const EXPECTED: Record<string, Row[]> = {
    git: [
        ["status", "local", "read"],
        ["diff", "local", "read"],
        ["log", "local", "read"],
        ["show", "local", "read"],
        ["blame", "local", "read"],
        ["branches", "local", "read"],
        ["fetch", "local", "read"],
        ["clone", "local", "write"],
        ["branch", "local", "write"],
        ["worktree", "local", "write"],
        ["commit", "local", "write"],
        ["stash", "local", "write"],
        ["sync", "local", "write"],
        ["merge", "local", "write"],
        ["rebase", "local", "write"],
        ["cherry_pick", "local", "write"],
        ["restore", "local", "write", { atLeast: "ask" }],
        ["push", "external", "write"],
    ],
    pr: [
        ["view", "external", "read"],
        ["list", "external", "read"],
        ["comments", "external", "read"],
        ["create", "external", "write", { approval: "review" }],
        ["edit", "external", "write", { approval: "review" }],
        ["ready", "external", "write"],
        ["comment", "external", "write", { approval: "review" }],
        ["reply", "external", "write", { approval: "review" }],
        ["resolve", "external", "write"],
        ["review", "external", "write", { approval: "review" }],
        ["merge", "external", "write"],
    ],
    checks: [
        ["status", "external", "read"],
        ["runs", "external", "read"],
        ["run", "external", "read"],
        ["artifacts", "external", "read"],
        ["log", "external", "read"],
        ["rerun", "external", "write"],
        ["watch", "local", "write"],
    ],
    release: [
        ["tags", "local", "read"],
        ["releases", "external", "read"],
        ["tag_create", "local", "write"],
        ["tag_push", "external", "write"],
        ["release_create", "external", "write"],
    ],
};

for (const [tool, rows] of Object.entries(EXPECTED)) {
    for (const [action, environment, effect, extra] of rows) {
        test(`${tool} ${action} is a ${environment} ${effect}${extra ? ` (${JSON.stringify(extra)})` : ""}`, () => {
            assert.deepEqual(classify(tool, { action }), { action, environment, effect, ...extra });
        });
    }
    test(`${tool}: an action nobody declared is unknown, so jig-core asks`, () => {
        assert.equal(classify(tool, { action: "reset" }), undefined);
        assert.equal(classify(tool, {}), undefined);
        assert.equal(classify(tool, { action: 5 }), undefined);
    });
}

test("the actions in the expectations are exactly the actions of the tools' tables", () => {
    const tables: Record<string, object> = {
        git: GIT_ACTIONS,
        pr: PR_ACTIONS,
        checks: CHECKS_ACTIONS,
        release: RELEASE_ACTIONS,
    };
    for (const [tool, rows] of Object.entries(EXPECTED)) {
        assert.deepEqual(
            rows.map((row) => row[0]),
            Object.keys(tables[tool] ?? {}),
            tool,
        );
    }
});

test("git worktree reads when it lists and writes when it adds or removes", () => {
    assert.deepEqual(classify("git", { action: "worktree", operation: "list" }), {
        action: "worktree",
        environment: "local",
        effect: "read",
    });
    assert.deepEqual(classify("git", { action: "worktree", operation: "add" }), {
        action: "worktree",
        environment: "local",
        effect: "write",
    });
    assert.deepEqual(classify("git", { action: "worktree", operation: "remove" }), {
        action: "worktree",
        environment: "local",
        effect: "write",
    });
    assert.equal(
        classify("git", { action: "worktree" })?.effect,
        "write",
        "without an operation it is treated as a write",
    );
});

test("the classification does not depend on anything but the action (and the worktree operation)", () => {
    const withText = classify("pr", { action: "comment", number: 4, body: "SECRET-BODY-TEXT" });
    assert.ok(!JSON.stringify(withText).includes("SECRET-BODY-TEXT"));
    assert.deepEqual(withText, classify("pr", { action: "comment" }));
    assert.deepEqual(classify("git", { action: "push", force_with_lease: true }), classify("git", { action: "push" }));
});

test("every tool is declared to jig-core as a jig-git tool, with a preview for the actions that can ask", () => {
    for (const tool of ["git", "pr", "checks", "release"]) {
        const declaration = h.jig.declared.get(tool);
        assert.equal(declaration?.plugin, "jig-git");
        assert.equal(declaration?.tool, tool);
        assert.equal(typeof declaration?.preview, "function");
    }
});

// ---- the README is the specification ------------------------------------------------------------------------------

const README = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");

/** The rows of the README's table under `## Tool: \`tool\``: the actions in the first cell and the kind, with the
 *  default decision, in the second. */
function readmeRows(tool: string): Array<{ actions: string[]; fallback: string }> {
    const start = README.indexOf(`## Tool: \`${tool}\``);
    assert.ok(start >= 0, `README has a section for ${tool}`);
    const rest = README.slice(start + 4);
    const end = rest.search(/\n##+ /);
    const section = rest.slice(0, end < 0 ? undefined : end);
    return section
        .split("\n")
        .filter((line) => line.startsWith("| `"))
        .map((line) => {
            const cells = line.split("|").map((cell) => cell.trim());
            return {
                actions: [...(cells[1] ?? "").matchAll(/`([a-z_]+)`/g)].map((match) => match[1] as string),
                fallback: cells[2] ?? "",
            };
        });
}

for (const tool of Object.keys(EXPECTED)) {
    test(`README: the ${tool} table names every action, with the default the code declares`, () => {
        const documented = new Map<string, string>();
        for (const row of readmeRows(tool)) for (const action of row.actions) documented.set(action, row.fallback);
        assert.deepEqual(
            [...documented.keys()].sort(),
            (EXPECTED[tool] ?? []).map((row) => row[0]).sort(),
            `the actions of ${tool}`,
        );
        for (const [action, environment, effect, extra] of EXPECTED[tool] ?? []) {
            const text = (documented.get(action) ?? "").replace(/\*\*/g, "");
            // The worktree action reads when it lists and writes when it adds or removes: the README says both.
            if (action === "worktree") assert.match(text, /^read; adding and removing are local writes/, text);
            else if (effect === "read") assert.match(text, /^read/, `${tool} ${action}: ${text}`);
            else if (environment === "external") assert.match(text, /^external write/, `${tool} ${action}: ${text}`);
            else assert.match(text, /^local write/, `${tool} ${action}: ${text}`);
            if (extra?.atLeast === "ask") assert.match(text, /asks/, `${tool} ${action}: ${text}`);
            if (extra?.approval === "review") assert.match(text, /review screen/, `${tool} ${action}: ${text}`);
        }
    });
}
