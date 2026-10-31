// The helper behind `npm run test:it` (test/support/it.ts): when a suite that needs a real service runs, is skipped, or fails.
import assert from "node:assert/strict";
import { test } from "node:test";
import { missing, must, optional, plan, requiredServices } from "../../../test/support/it.ts";
import type { Need, Plan } from "../../../test/support/it.ts";

/** Why a suite does not run; empty when it does. */
const reasonOf = (chosen: Plan): string => (chosen.kind === "run" ? "" : chosen.reason);

const need: Need = {
    service: "elasticsearch",
    variables: ["JIG_IT_ELASTICSEARCH_URL", "JIG_IT_ELASTICSEARCH_PASSWORD"],
    hint: "a throwaway Elasticsearch 8",
};

test("a suite runs when every variable of its service is set", () => {
    const env = { JIG_IT_ELASTICSEARCH_URL: "https://localhost:9200", JIG_IT_ELASTICSEARCH_PASSWORD: "x" };
    assert.deepEqual(missing(need, env), []);
    assert.deepEqual(plan(need, env), { kind: "run" });
});

test("a suite is skipped, with the variables to set, when one is missing or empty", () => {
    const chosen = plan(need, {
        JIG_IT_ELASTICSEARCH_URL: "https://localhost:9200",
        JIG_IT_ELASTICSEARCH_PASSWORD: "",
    });
    assert.equal(chosen.kind, "skip");
    assert.match(reasonOf(chosen), /^JIG_IT_ELASTICSEARCH_PASSWORD is not set: start a throwaway/);
    assert.match(reasonOf(chosen), /docs\/integration-tests\.md/);
    assert.match(reasonOf(plan(need, {})), /JIG_IT_ELASTICSEARCH_URL, JIG_IT_ELASTICSEARCH_PASSWORD are not set/);
});

test("a service that CI requires fails instead of skipping", () => {
    const chosen = plan(need, { JIG_IT_REQUIRE: "loki, elasticsearch" });
    assert.equal(chosen.kind, "fail");
    assert.match(reasonOf(chosen), /JIG_IT_REQUIRE lists elasticsearch: the service did not start/);
    assert.equal(plan(need, { JIG_IT_REQUIRE: "loki" }).kind, "skip");
});

test("the required list ignores spaces and empty entries", () => {
    assert.deepEqual(requiredServices({ JIG_IT_REQUIRE: " a, ,b ," }), ["a", "b"]);
    assert.deepEqual(requiredServices({}), []);
});

test("must names the variable that is missing, and optional treats empty as absent", () => {
    assert.equal(must("A", { A: "1" }), "1");
    assert.throws(() => must("A", { A: "" }), /^Error: A is not set$/);
    assert.equal(optional("A", { A: "" }), undefined);
    assert.equal(optional("A", { A: "x" }), "x");
});
