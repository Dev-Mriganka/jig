// The runtime tool as a model and jig-core meet it: how a call is classified, what each action returns, and what a wrong call
// is told.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createRuntimeTool } from "../src/runtime/tool.ts";
import { list, pod, workload } from "./support/fixtures.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { section, withEnvironment } from "./support/section.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

const POD = { service: "orders-api", environment: "staging" };
const KNOWN = "Known services: orders-api (staging, production), billing (staging)";

describe("classification", () => {
    test("every action is a read, in the jig-core environment that has the catalog's name for it", () => {
        for (const action of ["pods", "rollout", "logs", "events", "health"]) {
            assert.deepEqual(h.runtime.declaration.classify({ action, ...POD }), { action, environment: "staging", effect: "read" }, action);
        }
        assert.deepEqual(h.runtime.declaration.classify({ action: "pods", service: "orders-api", environment: "production" }), {
            action: "pods",
            environment: "production",
            effect: "read",
        });
        assert.deepEqual(h.runtime.declaration.classify({ action: "health", service: "orders-api", environment: "production" }), {
            action: "health",
            environment: "production",
            effect: "read",
        });
    });

    test("says nothing more: no stricter default, no approval screen, no preview, and jig-core masks the result", () => {
        for (const environment of ["staging", "production"]) {
            const cls = h.runtime.declaration.classify({ action: "logs", service: "orders-api", environment });
            assert.deepEqual(Object.keys(cls ?? {}).sort(), ["action", "effect", "environment"]);
        }
        assert.equal(h.runtime.declaration.masksOwnResults, undefined);
        assert.equal(h.runtime.declaration.preview, undefined, "a read has nothing to confirm");
        assert.equal(h.runtime.declaration.tool, "runtime");
        assert.equal(h.runtime.declaration.plugin, "jig-ops");
    });

    test("a read of production is a read in production: allowed by jig-core and masked there, and masked by nobody here", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0", { service: "orders-api" })) });
        const result = await h.runtime.call({ action: "pods", service: "orders-api", environment: "production" });
        assert.equal(result.cls?.environment, "production");
        assert.equal(result.cls?.effect, "read");
        assert.match(ok(result), /^1 pod of orders-api in production \(namespace orders\):/);
        assert.deepEqual(h.jig.started.length, 1);
    });

    test("an environment is classified under its own name, which is the name jig-core knows it by", () => {
        const raw = section();
        const orders = (raw.services as Record<string, { environments: Record<string, unknown> }>)["orders-api"] as { environments: Record<string, unknown> };
        orders.environments.qa = orders.environments.staging;
        h.configure(raw);
        assert.equal(h.runtime.declaration.classify({ action: "pods", service: "orders-api", environment: "qa" })?.environment, "qa");
    });

    test("is made from the catalog of the moment", () => {
        assert.throws(() => h.runtime.declaration.classify({ action: "pods", service: "orders-api", environment: "qa" }), TypeError);
        const raw = section();
        const orders = (raw.services as Record<string, { environments: Record<string, unknown> }>)["orders-api"] as { environments: Record<string, unknown> };
        orders.environments.qa = orders.environments.staging;
        h.configure(raw);
        assert.equal(h.runtime.declaration.classify({ action: "pods", service: "orders-api", environment: "qa" })?.environment, "qa");
    });

    test("touches no cluster, starts no program, and makes no request", () => {
        h.runtime.declaration.classify({ action: "pods", ...POD });
        h.runtime.declaration.classify({ action: "rollout", ...POD, waitFor: "1.4.2" });
        h.runtime.declaration.classify({ action: "health", ...POD });
        assert.deepEqual(h.cluster.calls(), []);
        assert.deepEqual(h.jig.started, []);
    });
});

describe("invalid input", () => {
    test("an unknown service is a TypeError that names the services there are", () => {
        assert.throws(
            () => h.runtime.declaration.classify({ action: "pods", service: "nope", environment: "staging" }),
            (error: unknown) => error instanceof TypeError && error.message === `runtime: no service named "nope". ${KNOWN}`,
        );
    });

    test("an unknown environment is a TypeError that names the service's environments", () => {
        assert.throws(
            () => h.runtime.declaration.classify({ action: "pods", service: "orders-api", environment: "qa" }),
            (error: unknown) => error instanceof TypeError && error.message === 'runtime: orders-api has no environment "qa". Known environments: staging, production',
        );
    });

    test("a call that breaks any limit is a TypeError too, so nobody is asked about a call that cannot run", () => {
        for (const input of [
            { action: "logs", ...POD, tail: 5000 },
            { action: "rollout", ...POD, timeoutSec: 30 },
            { action: "rollout", ...POD, waitFor: "1.4.2", timeoutSec: 601 },
            { action: "health", ...POD, path: "/a/../b" },
            { action: "pods", ...POD, extra: true },
            { action: "scale", ...POD },
            {},
        ]) {
            assert.throws(() => h.runtime.declaration.classify(input), TypeError, JSON.stringify(input));
        }
    });

    test("is blocked by jig-core with the message, and nothing is asked and nothing runs", async () => {
        const result = await h.runtime.call({ action: "pods", service: "nope", environment: "staging" });
        assert.equal(result.blocked, `Blocked by jig-core: runtime cannot run with this input: runtime: no service named "nope". ${KNOWN}`);
        assert.equal(result.error, undefined, "the tool did not run");
        assert.equal(result.cls, undefined);
        assert.deepEqual(h.jig.started, []);
    });

    test("the tool refuses the same call when it is run without jig-core's check", async () => {
        await assert.rejects(
            h.runtime.tool.execute("c1", { action: "pods", service: "nope", environment: "staging" } as never, undefined, undefined, {} as never),
            (error: unknown) => error instanceof TypeError && /no service named "nope"/.test(error.message),
        );
        await assert.rejects(
            h.runtime.tool.execute("c2", { action: "logs", ...POD, tail: 0 } as never, undefined, undefined, {} as never),
            (error: unknown) => error instanceof TypeError && /tail must be a whole number from 1 to 2000/.test(error.message),
        );
        assert.deepEqual(h.jig.started, []);
    });

    test("without a valid section the tool is not set up, and says what to add", async () => {
        const message = 'ops is not set up: add an "ops" section with "services" to jig.json (/jig lists configuration problems)';
        for (const raw of [undefined, { services: {}, extra: 1 }, { services: { svc: { environments: { staging: { runtime: { kubernetes: { context: "c" } } } } } } }]) {
            h.jig.reset();
            if (raw !== undefined) h.jig.setSection("ops", raw);
            const result = await h.runtime.call({ action: "pods", ...POD });
            assert.equal(result.blocked, `Blocked by jig-core: runtime cannot run with this input: ${message}`);
            await assert.rejects(
                h.runtime.tool.execute("c1", { action: "pods", ...POD } as never, undefined, undefined, {} as never),
                (error: unknown) => error instanceof TypeError && error.message === message,
            );
        }
        assert.deepEqual(h.jig.started, []);
    });

    test("a bug in the plugin is not reported as the model's mistake", async () => {
        h.jig.api.config.section = () => {
            throw new TypeError("a bug, not an input");
        };
        assert.throws(
            () => h.runtime.declaration.classify({ action: "pods", ...POD }),
            (error: unknown) => error instanceof Error && !(error instanceof TypeError) && error.message === "internal error: a bug, not an input",
        );
        const result = await h.runtime.call({ action: "pods", ...POD });
        assert.equal(result.blocked, "jig-core could not decide: internal error: a bug, not an input");
    });

    test("an environment with no Kubernetes runtime has no pods to read, and the call is blocked with what it has", async () => {
        const result = await h.runtime.call({ action: "pods", service: "orders-api", environment: "production" });
        assert.equal(result.blocked, undefined, "production has a Kubernetes runtime in the default catalog");
        const onlyAddress = withEnvironment("orders-api", "production", { runtime: undefined });
        h.configure(onlyAddress);
        const blocked = await h.runtime.call({ action: "pods", service: "orders-api", environment: "production" });
        assert.equal(blocked.blocked, "Blocked by jig-core: runtime cannot run with this input: runtime pods: orders-api in production has no Kubernetes runtime in the catalog (it has a health address only)");
    });
});

describe("pods", () => {
    test("lists the pods and records how many are ready", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0", { created: "2026-10-15T08:55:00Z" }), pod("orders-api-1", { ready: false, waiting: "CrashLoopBackOff", restarts: 7, created: "2026-10-15T08:00:00Z" })) });
        const result = await h.runtime.call({ action: "pods", ...POD });
        assert.equal(
            ok(result),
            [
                "2 pods of orders-api in staging (namespace orders-staging):",
                "- orders-api-0: 1/1 ready, Running, 0 restarts, 5m, image 1.4.2",
                "- orders-api-1: 0/1 ready, CrashLoopBackOff, 7 restarts, 60m, image 1.4.2",
            ].join("\n"),
        );
        assert.deepEqual(h.jig.facts.get(result.id), [{ pods: 2, ready: 1 }]);
    });

    test("the age is read against the clock of the tool", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0", { created: "2026-10-12T09:00:00Z" })) });
        assert.match(ok(await h.runtime.call({ action: "pods", ...POD })), /, 3d, image/);
    });
});

describe("rollout", () => {
    test("reports the rollout, and records the verdict", async () => {
        h.cluster.answer({
            pods: list(pod("orders-api-0", { created: "2026-10-15T08:55:00Z" }), pod("orders-api-1", { created: "2026-10-15T08:55:00Z" })),
            workloads: list(workload("orders-api")),
        });
        const result = await h.runtime.call({ action: "rollout", ...POD });
        assert.match(ok(result), /^orders-api in staging \(namespace orders-staging\): Running: 2 of 2 pods ready on 1\.4\.2\.\nWorkload: StatefulSet orders-api, 2\/2 ready/);
        assert.deepEqual(h.jig.facts.get(result.id), [{ verdict: "running", pods: 2, ready: 2, polls: 1, timedOut: false }]);
        assert.equal((result.details as { verdict: string }).verdict, "running");
    });

    test("waits for a version, says how it goes while it waits, and returns when it runs", async () => {
        h.cluster.answer({
            pods: [list(pod("orders-api-0", { tag: "1.4.2" }), pod("orders-api-1", { tag: "1.4.2" })), list(pod("orders-api-0", { tag: "1.4.3" }), pod("orders-api-1", { tag: "1.4.3" }))],
            workloads: list(workload("orders-api", { tag: "1.4.3" })),
        });
        const updates: string[] = [];
        const result = await h.runtime.call({ action: "rollout", ...POD, waitFor: "1.4.3", timeoutSec: 60 }, { updates });
        assert.match(ok(result).split("\n")[0] ?? "", /Running: 2 of 2 pods ready on 1\.4\.3\.$/);
        assert.deepEqual(updates, ["orders-api staging: 0 of 2 ready on 1.4.3, running 1.4.2"]);
        assert.deepEqual(h.clock.sleeps, [2000]);
    });

    test("is still rolling when the version does not arrive in time, and says so", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0", { tag: "1.4.2" }), pod("orders-api-1", { tag: "1.4.2" })), workloads: list(workload("orders-api")) });
        const result = await h.runtime.call({ action: "rollout", ...POD, waitFor: "1.4.3", timeoutSec: 5 });
        assert.match(ok(result).split("\n")[0] ?? "", /Still rolling after waiting 5s: 0 of 2 pods ready on 1\.4\.3; pods run 1\.4\.2\.$/);
        assert.equal((h.jig.facts.get(result.id)?.[0] ?? {}).timedOut, true);
    });

    test("a wait the user stops is an error, and the tool call ends", async () => {
        const controller = new AbortController();
        h.cluster.answer({ pods: list(pod("orders-api-0", { tag: "1.4.2" })), workloads: list(workload("orders-api", { replicas: 1 })) });
        h.clock.afterSleep = () => controller.abort();
        const result = await h.runtime.call({ action: "rollout", ...POD, waitFor: "1.4.3" }, { signal: controller.signal });
        assert.match(result.error?.message ?? "", /^runtime rollout: the wait was stopped/);
    });
});

describe("rollout, with the real clock and real timers", () => {
    // The harness gives the tool a clock that moves when a wait sleeps. Without one, the tool uses Date.now and setTimeout.
    const real = () => createRuntimeTool().definition;
    const stale = () => h.cluster.answer({ pods: list(pod("orders-api-0", { tag: "1.4.2" }), pod("orders-api-1", { tag: "1.4.2" })), workloads: list(workload("orders-api")) });

    test("a wait that runs out of time takes that time, and says so", async () => {
        stale();
        const started = Date.now();
        const result = await real().execute("real-1", { action: "rollout", ...POD, waitFor: "9.9.9", timeoutSec: 1 } as never, undefined, undefined, {} as never);
        const first = result.content[0];
        assert.match(first?.type === "text" ? first.text : "", /^orders-api in staging \(namespace orders-staging\): Still rolling after waiting [12]s: 0 of 2 pods ready on 9\.9\.9; pods run 1\.4\.2\./);
        const took = Date.now() - started;
        assert.ok(took >= 900 && took < 6000, `${took} ms`);
    });

    test("a wait the user stops ends at once, and not at the limit", async () => {
        stale();
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        const started = Date.now();
        await assert.rejects(
            real().execute("real-2", { action: "rollout", ...POD, waitFor: "9.9.9", timeoutSec: 60 } as never, controller.signal, undefined, {} as never),
            /^Error: runtime rollout: the wait was stopped/,
        );
        assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
    });

    test("a call that was already stopped does not start", async () => {
        stale();
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            real().execute("real-3", { action: "rollout", ...POD, waitFor: "9.9.9" } as never, controller.signal, undefined, {} as never),
            /^Error: (kubectl was aborted|runtime rollout: the wait was stopped)/,
        );
    });
});

describe("logs", () => {
    test("reads the first ready pod and records the number of lines", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0", { ready: false }), pod("orders-api-1")), logs: { stdout: "one\ntwo\n" } });
        const result = await h.runtime.call({ action: "logs", ...POD, tail: 10, sinceSeconds: 60 });
        assert.equal(ok(result), "orders-api-1 (container orders-api): 2 lines (tail 10, last 60 s)\none\ntwo");
        assert.deepEqual(h.jig.facts.get(result.id), [{ lines: 2, previous: false, cut: false }]);
    });

    test("a pod of another service is refused", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: "x\n" } });
        const result = await h.runtime.call({ action: "logs", ...POD, pod: "billing-0" });
        assert.match(result.error?.message ?? "", /^billing-0 is not a pod of orders-api in staging/);
        assert.equal(h.cluster.calls().filter((c) => c.argv[3] === "logs").length, 0);
    });
});

describe("errors from the cluster", () => {
    test("reach the model as one line that says what to do", async () => {
        h.cluster.answer({ pods: { code: 1, stderr: "error: You must be logged in to the server (Unauthorized)" } });
        const result = await h.runtime.call({ action: "pods", ...POD });
        assert.match(result.error?.message ?? "", /^kubectl is not signed in to context test-cluster \(error: You must be logged in to the server \(Unauthorized\)\): the user signs in again for that context outside Pi, then retry$/);
        assert.equal(result.text, "");
    });

    test("a service in a cluster the kubeconfig does not know says which setting to fix", async () => {
        h.cluster.answer({ pods: { code: 1, stderr: 'error: context "test-cluster" does not exist' } });
        const result = await h.runtime.call({ action: "pods", ...POD });
        assert.match(result.error?.message ?? "", /fix "context" in the ops catalog of jig\.json/);
    });
});
