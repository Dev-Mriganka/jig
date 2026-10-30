// `deploy plan` and `deploy status`: the reads. A plan says what is running now and what a deploy would run; status says what
// the last deploy from here did, and how the rollout stands.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { list, pod, workload } from "./support/fixtures.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { BILLING, billing, ORDERS, orders } from "./support/worlds.ts";
import { section, withCopy, withEnvironment } from "./support/section.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

const plan = (version: string, where: Record<string, unknown> = ORDERS) => h.deploy.call({ action: "plan", ...where, version });
const status = (where: Record<string, unknown> = ORDERS) => h.deploy.call({ action: "status", ...where });

describe("plan", () => {
    test("says what runs now, what is asked for, and the command a deploy would run", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await plan("1.4.3");
        assert.equal(
            ok(result),
            [
                "Deploy plan for orders-api in staging (test): method helm.",
                "Running now: 1.4.2",
                "Requested:   1.4.3",
                "Rollout now: Running: 2 of 2 pods ready on 1.4.2.",
                "Command:     helm upgrade --install orders-api deploy/chart --kube-context test-cluster --namespace orders-staging --set image.tag=1.4.3 --wait=false",
                "deploy run asks the user first and does not wait for the rollout; deploy watch does.",
            ].join("\n"),
        );
        assert.deepEqual(h.jig.facts.get(result.id), [{ method: "helm", same: false }]);
    });

    test("is a read: it asks nobody, starts no helm, and only gets from the cluster", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await plan("1.4.3");
        assert.deepEqual(result.cls, { action: "plan", environment: "staging", effect: "read" });
        assert.equal(result.preview, undefined, "a read is not asked about");
        assert.deepEqual(h.cluster.helmCalls(), []);
        assert.deepEqual(h.cluster.calls().map((call) => call.argv[3]), ["get", "get"]);
    });

    test("for kubectl set image reads the workload, and shows the image with only the tag changed", async () => {
        h.cluster.answer(billing("2.0.0"));
        const text = ok(await plan("2.1.0", BILLING));
        assert.match(text, /^Deploy plan for billing in staging \(test\): method kubectl-image\.\nRunning now: 2\.0\.0\nRequested:   2\.1\.0\n/);
        assert.match(text, /\nCommand:     kubectl --request-timeout=50s --context=test-cluster --namespace=billing-staging set image deployment\/billing billing=registry\.example\.test\/shop\/billing:2\.1\.0\n/);
        assert.deepEqual(h.cluster.calls().map((call) => call.argv.slice(3, 5)), [["get", "pods"], ["get", "deployments,statefulsets"], ["get", "deployment/billing"]]);
    });

    test("says when the version asked for is the one that already runs", async () => {
        h.cluster.answer(orders("1.4.3"));
        const result = await plan("1.4.3");
        assert.match(ok(result), /\nRequested:   1\.4\.3 \(already running: a deploy would change the release and not the version\)\n/);
        assert.deepEqual(h.jig.facts.get(result.id), [{ method: "helm", same: true }]);
    });

    test("says when a rollout is in progress, with the versions it runs", async () => {
        h.cluster.answer(orders("1.4.2", { pods: list(pod("orders-api-0", { tag: "1.4.3" }), pod("orders-api-1", { tag: "1.4.2" })) }));
        const text = ok(await plan("1.4.4"));
        assert.match(text, /\nRunning now: 1\.4\.2, 1\.4\.3 \(a rollout is in progress\)\n/);
        assert.match(text, /\nRollout now: Still rolling: 2 of 2 pods ready; pods run 1\.4\.3, 1\.4\.2\.\n/);
    });

    test("says when nothing runs", async () => {
        h.cluster.answer(orders("1.4.2", { pods: list(), workloads: list(workload("orders-api", { replicas: 0 })) }));
        assert.match(ok(await plan("1.4.3")), /\nRunning now: none \(no pods are running\)\nRequested:   1\.4\.3\n/);
    });

    test("says when the images carry no tag", async () => {
        h.cluster.answer(orders("1.4.2", { pods: list(pod("orders-api-0", { image: "registry.example.test/shop/orders-api@sha256:abc" })) }));
        assert.match(ok(await plan("1.4.3")), /\nRunning now: no tag \(the images have none\)\n/);
    });

    test("where the agent does not deploy, says why and still says what runs: production, and an environment without a method", async () => {
        h.cluster.answer(orders("1.4.2"));
        const production = await plan("1.4.3", { service: "orders-api", environment: "production" });
        assert.equal(
            ok(production),
            [
                "Deploy plan for orders-api in production (production):",
                "A deploy run would be refused: orders-api in production is production: the agent never changes production.",
                "Running now: 1.4.2",
            ].join("\n"),
        );
        assert.deepEqual(production.cls, { action: "plan", environment: "production", effect: "read" });
        assert.deepEqual(h.jig.facts.get(production.id), [{ refused: true }]);

        h.configure(withEnvironment("orders-api", "staging", { deploy: undefined }));
        assert.match(ok(await plan("1.4.3")), /\nA deploy run would be refused: the catalog gives orders-api in staging no deploy method: the agent deploys only where the catalog names one\.\n/);
        assert.deepEqual(h.cluster.helmCalls(), []);
    });

    test("an environment jig-core does not know counts as production, and the plan says how to fix that", async () => {
        h.cluster.answer(orders("1.4.2"));
        h.configure(withCopy(section(), "orders-api", "staging", "preview"));
        const text = ok(await plan("1.4.3", { service: "orders-api", environment: "preview" }));
        assert.match(text, /A deploy run would be refused: orders-api in preview is production: the agent never changes production\. jig-core counts a name it does not know as production: if preview is a test environment, define it under "environments" in jig\.json with kind test\./);
    });

    test("a cluster that cannot be read is an error that says what to do, and nothing is planned", async () => {
        h.cluster.answer({ pods: { code: 1, stderr: "Unable to connect to the server: dial tcp: i/o timeout" } });
        const result = await plan("1.4.3");
        assert.match(result.error?.message ?? "", /^Cannot reach the cluster of context test-cluster for orders-api in staging/);
    });
});

describe("status", () => {
    test("says that nothing was deployed from here, and shows the rollout", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await status();
        const lines = ok(result).split("\n");
        assert.equal(lines[0], "No deploy or rollback was run from here in this session. The rollout is as the cluster shows it now.");
        assert.equal(lines[1], "orders-api in staging (namespace orders-staging): Running: 2 of 2 pods ready on 1.4.2.");
        assert.match(lines[2] ?? "", /^Workload: StatefulSet orders-api, 2\/2 ready/);
        assert.deepEqual(h.jig.facts.get(result.id), [{ verdict: "running", last: "none" }]);
        assert.deepEqual(result.cls, { action: "status", environment: "staging", effect: "read" });
    });

    test("after a deploy, says what it was and how it went, and judges the rollout against its version", async () => {
        h.cluster.answer(orders("1.4.2"));
        ok(await h.deploy.call({ action: "run", ...ORDERS, version: "1.4.3" }));
        const lines = ok(await status()).split("\n");
        assert.equal(lines[0], "Last run from here: the deploy of 1.4.3 with helm, 0s ago, while 1.4.2 was running: started.");
        assert.equal(lines[1], "orders-api in staging (namespace orders-staging): Still rolling: 0 of 2 pods ready on 1.4.3; pods run 1.4.2.");
        assert.match(lines[3] ?? "", /image 1\.4\.2 {2}<- not ready on 1\.4\.3$/);
    });

    test("once the pods run the version, says it is running", async () => {
        h.cluster.answer(orders("1.4.2"));
        ok(await h.deploy.call({ action: "run", ...ORDERS, version: "1.4.3" }));
        h.cluster.answer(orders("1.4.3"));
        const result = await status();
        assert.equal(ok(result).split("\n")[1], "orders-api in staging (namespace orders-staging): Running: 2 of 2 pods ready on 1.4.3.");
        assert.deepEqual(h.jig.facts.get(result.id), [{ verdict: "running", last: "started" }]);
    });

    test("keeps a record per service and environment", async () => {
        h.cluster.answer(orders("1.4.2"));
        ok(await h.deploy.call({ action: "run", ...ORDERS, version: "1.4.3" }));
        h.cluster.answer(billing("2.0.0"));
        assert.match(ok(await status(BILLING)), /^No deploy or rollback was run from here/);
    });

    test("a deploy that failed is told, and the rollout is not judged against its version", async () => {
        h.cluster.answer(orders("1.4.2", { helmUpgrade: { code: 1, stderr: "Error: UPGRADE FAILED: an error occurred" } }));
        const failed = await h.deploy.call({ action: "run", ...ORDERS, version: "1.4.3" });
        assert.match(failed.error?.message ?? "", /^helm upgrade failed \(exit 1\)/);
        const lines = ok(await status()).split("\n");
        assert.equal(lines[0], "Last run from here: the deploy of 1.4.3 with helm, 0s ago, while 1.4.2 was running: failed.");
        assert.match(lines[1] ?? "", /Running: 2 of 2 pods ready on 1\.4\.2\.$/);
    });

    test("an environment where the agent does not deploy can still be looked at", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await status({ service: "orders-api", environment: "production" });
        assert.match(ok(result), /^No deploy or rollback was run from here/);
        assert.equal(result.cls?.environment, "production");
    });
});
