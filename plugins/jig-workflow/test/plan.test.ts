// plan.md: what it must hold, the fingerprint, and the numbered scenarios.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    fingerprintOf,
    MAX_PLAN_CHARS,
    MAX_SCENARIOS,
    normalized,
    parsePlan,
    repositoryWarnings,
} from "../src/plan.ts";

const GOOD = `# PROJ-123 plan

## Approach
Cache the price list in OrdersService and invalidate it when a price changes.

## Repositories
- orders-api
- \`billing-api\` (only the client)

## Scenarios
1. A customer reads the price list twice; the second read does not reach the database.
2. A price changes; the next read shows the new price,
   and the cache holds one entry.
`;

describe("a plan that passes", () => {
    test("is read into an approach, repositories and scenarios", () => {
        const plan = parsePlan(GOOD);
        assert.deepEqual(plan.problems, []);
        assert.match(plan.approach, /^Cache the price list/);
        assert.deepEqual(plan.repositories, ["orders-api", "billing-api"]);
        assert.deepEqual(
            plan.scenarios.map((scenario) => [scenario.number, scenario.text]),
            [
                [1, "A customer reads the price list twice; the second read does not reach the database."],
                [2, "A price changes; the next read shows the new price, and the cache holds one entry."],
            ],
        );
        assert.equal(plan.fingerprint, fingerprintOf(GOOD));
    });

    test("headings match without regard to case, in any order, at any level", () => {
        const plan = parsePlan("### scenarios\n1. one\n\n# REPOSITORIES\n* a\n\n## Approach\ntext\n");
        assert.deepEqual(plan.problems, []);
        assert.equal(plan.scenarios.length, 1);
    });

    test("a section includes the sections below it", () => {
        const plan = parsePlan("## Approach\nA\n### Why\nBecause.\n## Repositories\n- a\n## Scenarios\n1. x\n");
        assert.match(plan.approach, /Because\./);
    });

    test("a numbered list may use 1) and indented lines continue a scenario", () => {
        const plan = parsePlan(
            "## Approach\nx\n## Repositories\n- a\n## Scenarios\n1) first\n    more of it\n2) second\n",
        );
        assert.deepEqual(plan.problems, []);
        assert.equal(plan.scenarios[0]?.text, "first more of it");
    });

    test("a heading inside a code block is not a heading", () => {
        const plan = parsePlan(`${GOOD}\n\`\`\`\n## Scenarios\n1. fake\n\`\`\`\n`);
        assert.deepEqual(plan.problems, []);
        assert.equal(plan.scenarios.length, 2);
    });
});

describe("a plan that is refused says why", () => {
    const problems = (text: string) => parsePlan(text).problems.join("\n");

    test("each missing heading", () => {
        const text = problems("# empty\n");
        assert.match(text, /## Approach: add the heading/);
        assert.match(text, /## Repositories: add the heading/);
        assert.match(text, /## Scenarios: add the heading/);
    });

    test("a heading with nothing under it", () => {
        const text = problems("## Approach\n\n## Repositories\n\n## Scenarios\n\n");
        assert.match(text, /## Approach: is empty/);
        assert.match(text, /## Repositories: needs a list/);
        assert.match(text, /## Scenarios: needs a numbered list/);
    });

    test("scenarios that do not count from 1 without a gap", () => {
        assert.match(
            problems("## Approach\nx\n## Repositories\n- a\n## Scenarios\n1. a\n3. c\n"),
            /found 3 where 2 belongs/,
        );
        assert.match(problems("## Approach\nx\n## Repositories\n- a\n## Scenarios\n2. a\n"), /found 2 where 1 belongs/);
    });

    test("an empty scenario, too many scenarios, a heading twice", () => {
        assert.match(
            problems("## Approach\nx\n## Repositories\n- a\n## Scenarios\n1.   \n"),
            /scenario 1 is empty|needs a numbered list/,
        );
        const many = Array.from({ length: MAX_SCENARIOS + 1 }, (_, n) => `${n + 1}. s${n}`).join("\n");
        assert.match(
            problems(`## Approach\nx\n## Repositories\n- a\n## Scenarios\n${many}\n`),
            new RegExp(`at most ${MAX_SCENARIOS} scenarios`),
        );
        assert.match(problems(`${GOOD}\n## Approach\nagain\n`), /Approach: the plan has this heading twice/);
    });

    test("a plan too long to review", () => {
        assert.match(problems(`${GOOD}${"x".repeat(MAX_PLAN_CHARS)}`), /is the most that can be reviewed/);
    });
});

describe("the fingerprint", () => {
    test("line endings do not change it, and any other edit does", () => {
        assert.equal(fingerprintOf(GOOD), fingerprintOf(GOOD.replace(/\n/g, "\r\n")));
        assert.equal(normalized("a\r\nb\rc"), "a\nb\nc");
        assert.notEqual(fingerprintOf(GOOD), fingerprintOf(GOOD.replace("price list", "price-list")));
        assert.notEqual(fingerprintOf(GOOD), fingerprintOf(`${GOOD} `));
        assert.match(fingerprintOf(GOOD), /^[0-9a-f]{64}$/);
    });

    test("a scenario's hash follows its words and not its number", () => {
        const a = parsePlan("## Approach\nx\n## Repositories\n- a\n## Scenarios\n1. same words\n2. other\n");
        const b = parsePlan("## Approach\nx\n## Repositories\n- a\n## Scenarios\n1. changed\n2. other\n");
        assert.notEqual(a.scenarios[0]?.hash, b.scenarios[0]?.hash);
        assert.equal(a.scenarios[1]?.hash, b.scenarios[1]?.hash);
    });
});

describe("naming the repositories", () => {
    const bound = [
        { root: "/w/orders-api-PROJ-1", names: ["orders-api-PROJ-1", "orders-api"] },
        { root: "/w/billing-api", names: ["billing-api"] },
    ];

    test("no warning when the plan names every bound repository by one of its names", () => {
        assert.deepEqual(repositoryWarnings(parsePlan(GOOD), bound), []);
    });

    test("a bound repository the plan leaves out, and a name that no bound repository has", () => {
        const plan = parsePlan(GOOD.replace("billing-api", "shipping-api"));
        const warnings = repositoryWarnings(plan, bound);
        assert.ok(warnings.includes("the plan does not name billing-api, which is bound to the ticket"));
        assert.ok(warnings.includes("the plan names shipping-api, and no bound repository has that name"));
    });

    test("nothing is said while nothing is bound", () => {
        assert.deepEqual(repositoryWarnings(parsePlan(GOOD), []), []);
    });
});
