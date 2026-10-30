// The watch kind `ops-rollout`, and the `deploy watch` action that starts it. The kind is polled here the way jig-core's engine
// polls it, with a clock that only moves when a test moves it, so a rollout of fifteen minutes takes a few milliseconds.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PollOutcome } from "../../jig-core/src/contract.ts";
import { KIND } from "../src/watch.ts";
import type { RolloutSpec, RolloutState } from "../src/watch.ts";
import { NOW } from "./support/clock.ts";
import { list, pod } from "./support/fixtures.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { withEntry, withEnvironment } from "./support/section.ts";
import { ORDERS, orders } from "./support/worlds.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

const watch = (more: Record<string, unknown> = {}, where: Record<string, unknown> = ORDERS) => h.deploy.call({ action: "watch", ...where, version: "1.4.3", ...more });

describe("starting a watch", () => {
    test("starts the kind with the names of the service, its environment and the version, and returns its id at once", async () => {
        const result = await watch();
        assert.equal(
            ok(result),
            "Watching the rollout of orders-api to 1.4.3 in staging as watch-1. One message arrives when every pod is ready on 1.4.3, when a pod cannot come up, or after 15 minutes. The watch tool lists and stops watches.",
        );
        assert.equal(h.jig.watches.length, 1);
        const [started] = h.jig.watches;
        assert.equal(started?.kind, "ops-rollout");
        assert.equal(started?.title, "rollout of orders-api to 1.4.3 in staging");
        assert.deepEqual(started?.spec, { service: "orders-api", environment: "staging", version: "1.4.3", startedAt: NOW, deadline: NOW + 15 * 60_000 - 5_000 });
        assert.equal(started?.timeoutMinutes, 15);
        assert.equal(started?.stallMinutes, 8);
        assert.deepEqual(h.jig.facts.get(result.id), [{ watch: "started" }]);
    });

    test("saves names and no more: no context, no namespace, no selector, nothing that could point it elsewhere", async () => {
        await watch();
        assert.deepEqual(Object.keys(h.jig.watches[0]?.spec as object).sort(), ["deadline", "environment", "service", "startedAt", "version"]);
        assert.equal(JSON.stringify(h.jig.watches[0]?.spec).includes("cluster"), false);
    });

    test("is a local write: it starts something on this machine and changes no environment, so it asks nobody", async () => {
        const result = await watch();
        assert.deepEqual(result.cls, { action: "watch", environment: "local", effect: "write" });
        assert.equal(result.preview, undefined);
    });

    test("reads nothing from the cluster when it starts: the first poll does", async () => {
        await watch();
        assert.deepEqual(h.cluster.calls(), []);
        assert.deepEqual(h.jig.started, []);
    });

    test("takes the number of minutes it is given, and the deadline follows", async () => {
        const result = await watch({ timeoutMinutes: 40 });
        const [started] = h.jig.watches;
        assert.equal(started?.timeoutMinutes, 40);
        assert.equal(started?.stallMinutes, 20);
        assert.equal((started?.spec as RolloutSpec).deadline, NOW + 40 * 60_000 - 5_000);
        assert.match(ok(result), /or after 40 minutes\./);
        await watch({ timeoutMinutes: 1, version: "1.4.4" });
        assert.equal(h.jig.watches[1]?.stallMinutes, 1);
        assert.equal((h.jig.watches[1]?.spec as RolloutSpec).deadline, NOW + 55_000);
    });

    test("watching what is already watched returns the watch there is, and starts no second", async () => {
        await watch();
        const again = await watch();
        assert.equal(ok(again), "Already watching the rollout of orders-api to 1.4.3 in staging as watch-1. One message arrives when it ends.");
        assert.equal(h.jig.watches.length, 1);
        assert.deepEqual(h.jig.facts.get(again.id), [{ watch: "existing" }]);
    });

    test("another version, another environment or another service is another watch, and a watch that has ended does not count", async () => {
        await watch();
        await watch({ version: "1.4.4" });
        await watch({}, { service: "orders-api", environment: "production" });
        await watch({}, { service: "billing", environment: "staging" });
        assert.equal(h.jig.watches.length, 4);
        h.jig.api.watches.stop("watch-1");
        await watch();
        assert.equal(h.jig.watches.length, 5);
    });

    test("is allowed in an environment the agent does not deploy to: it only reads", async () => {
        const result = await watch({}, { service: "orders-api", environment: "production" });
        assert.equal(result.blocked, undefined);
        assert.equal(result.cls?.environment, "local");
        assert.equal((h.jig.watches[0]?.spec as RolloutSpec).environment, "production");
    });

    test("a version that is not an image tag is blocked before a watch is started", async () => {
        const result = await watch({ version: "--set x=y" });
        assert.match(result.blocked ?? "", /deploy watch: version must be an image tag/);
        assert.deepEqual(h.jig.watches, []);
    });

    test("an engine that cannot start it says why", async () => {
        h.jig.api.watches.start = () => {
            throw new Error("a watch can be started only while a session is running");
        };
        assert.equal((await watch()).error?.message, "a watch can be started only while a session is running");
    });
});

describe("the watch kind", () => {
    const kind = () => {
        const found = h.jig.kinds.get(KIND) as unknown as {
            kind: string;
            plugin: string;
            intervalMs: number;
            describe(spec: RolloutSpec): string;
            poll(spec: RolloutSpec, state: RolloutState | undefined, signal: AbortSignal): Promise<PollOutcome<RolloutState>>;
        };
        assert.ok(found, "the kind is registered");
        return found;
    };
    const SPEC: RolloutSpec = { service: "orders-api", environment: "staging", version: "1.4.3", startedAt: NOW, deadline: NOW + 15 * 60_000 - 5_000 };
    const poll = (spec: RolloutSpec = SPEC, state?: RolloutState) => kind().poll(spec, state, new AbortController().signal);
    /** Moves the clock the kind reads, as the minutes of a rollout pass. */
    const later = (ms: number) => h.clock.deps.sleep(ms, undefined);

    test("is named ops-rollout, belongs to this plugin, polls every ten seconds, and says what it watches", () => {
        assert.equal(kind().kind, "ops-rollout");
        assert.equal(kind().plugin, "jig-ops");
        assert.equal(kind().intervalMs, 10_000);
        assert.equal(kind().describe(SPEC), "rollout of orders-api to 1.4.3 in staging");
    });

    test("goes on while the pods run the old version, and asks for the next poll at the kind's own interval", async () => {
        h.cluster.answer(orders("1.4.2"));
        const outcome = await poll();
        assert.deepEqual(outcome, { state: { polls: 1 } });
        assert.equal(outcome.done, undefined);
        assert.equal(outcome.nextPollMs, undefined);
    });

    test("goes on while a pod is not ready yet, or fewer pods than wanted run", async () => {
        h.cluster.answer(orders("1.4.3", { pods: list(pod("orders-api-0", { tag: "1.4.3" }), pod("orders-api-1", { tag: "1.4.3", ready: false })) }));
        assert.equal((await poll()).done, undefined);
        h.cluster.answer(orders("1.4.3", { pods: list(pod("orders-api-0", { tag: "1.4.3" })) }));
        assert.equal((await poll()).done, undefined);
    });

    test("goes on while there are no pods, which may yet appear", async () => {
        h.cluster.answer(orders("1.4.3", { pods: list() }));
        assert.equal((await poll()).done, undefined);
    });

    test("passes when every pod is ready on the version, and says so with the pods", async () => {
        h.cluster.answer(orders("1.4.3"));
        const outcome = await poll(SPEC, { polls: 4 });
        assert.deepEqual(outcome.state, { polls: 5 });
        assert.equal(outcome.done?.outcome, "passed");
        assert.equal(outcome.done?.summary, "orders-api in staging: Running: 2 of 2 pods ready on 1.4.3.");
        assert.match(outcome.done?.details ?? "", /^Workload: StatefulSet orders-api, 2\/2 ready, 2 updated, revision orders-api-5d9f, image 1\.4\.3\.\n- orders-api-0: 1\/1 ready, Running, 0 restarts, 60m, image 1\.4\.3\n- orders-api-1: /);
        assert.deepEqual(outcome.done?.facts, { verdict: "running", pods: 2, ready: 2, polls: 5 });
    });

    test("passes at the deadline too, if the rollout finished by then: it is judged before the clock", async () => {
        h.cluster.answer(orders("1.4.3"));
        await later(20 * 60_000);
        assert.equal((await poll()).done?.outcome, "passed");
    });

    test("fails when a pod cannot come up, whatever the other pods do, and says which and where to read why", async () => {
        h.cluster.answer(orders("1.4.3", {
            pods: list(pod("orders-api-0", { tag: "1.4.3" }), pod("orders-api-1", { tag: "1.4.3", ready: false, waiting: "CrashLoopBackOff", restarts: 3 })),
        }));
        const outcome = await poll();
        assert.equal(outcome.done?.outcome, "failed");
        assert.equal(outcome.done?.summary, "orders-api in staging: Failing: pod orders-api-1 is CrashLoopBackOff (3 restarts). Read why with runtime logs (pod: orders-api-1, previous: true).");
        assert.match(outcome.done?.details ?? "", /- orders-api-1: 0\/1 ready, CrashLoopBackOff, 3 restarts/);
        assert.equal(outcome.done?.facts?.verdict, "failing");
        for (const waiting of ["ImagePullBackOff", "ErrImagePull"]) {
            h.cluster.answer(orders("1.4.3", { pods: list(pod("orders-api-0", { ready: false, waiting })) }));
            assert.equal((await poll()).done?.outcome, "failed", waiting);
        }
    });

    test("times out at the deadline, and says how far the rollout got and how long it waited", async () => {
        h.cluster.answer(orders("1.4.2"));
        await later(14 * 60_000);
        assert.equal((await poll()).done, undefined, "before the deadline it goes on");
        await later(60_000);
        const outcome = await poll();
        assert.equal(outcome.done?.outcome, "timed-out");
        assert.equal(outcome.done?.summary, "orders-api in staging: Still rolling after waiting 15m00s: 0 of 2 pods ready on 1.4.3; pods run 1.4.2.");
        assert.match(outcome.done?.details ?? "", /image 1\.4\.2 {2}<- not ready on 1\.4\.3/);
        assert.equal(outcome.done?.facts?.verdict, "rolling");
    });

    test("the deadline is a few seconds before the engine's, so the last poll is the kind's own", async () => {
        await watch({ timeoutMinutes: 15 });
        const spec = h.jig.watches[0]?.spec as RolloutSpec;
        const engineDeadline = NOW + 15 * 60_000;
        assert.ok(spec.deadline < engineDeadline && spec.deadline >= engineDeadline - 10_000);
        h.cluster.answer(orders("1.4.2"));
        await later(15 * 60_000 - 3_000);
        assert.equal((await poll(spec)).done?.outcome, "timed-out", "a poll a few seconds before the engine's deadline already ends it");
    });

    test("reads the cluster the catalog names for the service, not one the saved watch names", async () => {
        h.cluster.answer(orders("1.4.2"));
        const sneaky = { ...SPEC, context: "prod-cluster", namespace: "kube-system", selector: "app=other" } as RolloutSpec;
        await poll(sneaky);
        assert.deepEqual(h.cluster.calls().map((call) => call.argv.slice(1, 3)), [
            ["--context=test-cluster", "--namespace=orders-staging"],
            ["--context=test-cluster", "--namespace=orders-staging"],
        ]);
        assert.equal(h.cluster.calls()[0]?.argv[5], "--selector=app=orders-api");
    });

    test("reads the catalog of the moment, so a change applies to the next poll", async () => {
        h.cluster.answer(orders("1.4.2"));
        await poll();
        h.configure(withEntry("orders-api", "staging", { namespace: "moved" }));
        await poll();
        assert.deepEqual(h.cluster.calls().map((call) => call.argv[2]).filter((_, at) => at % 2 === 0), ["--namespace=orders-staging", "--namespace=moved"]);
    });

    test("only reads: kubectl gets pods and workloads, nothing is changed, and helm is never started", async () => {
        h.cluster.answer(orders("1.4.2"));
        await poll();
        assert.deepEqual(h.cluster.calls().map((call) => call.argv.slice(3, 5)), [["get", "pods"], ["get", "deployments,statefulsets"]]);
        assert.deepEqual(h.cluster.helmCalls(), []);
    });

    test("hands the engine's signal to kubectl, so a poll that is cancelled stops its reads", async () => {
        h.cluster.answer(orders("1.4.2"));
        const controller = new AbortController();
        await kind().poll(SPEC, undefined, controller.signal);
        assert.ok(h.jig.started.length > 0);
        assert.ok(h.jig.started.every((started) => started.options.signal === controller.signal));
    });

    test("a cluster that cannot be read is a failed poll, which the engine counts, and not an end", async () => {
        h.cluster.answer({ pods: { code: 1, stderr: "Unable to connect to the server: dial tcp: i/o timeout" } });
        await assert.rejects(poll(), /^Error: Cannot reach the cluster of context test-cluster for orders-api in staging/);
    });

    test("a catalog without the service is a failed poll too, with the names there are", async () => {
        await assert.rejects(poll({ ...SPEC, service: "gone" }), (error: unknown) => error instanceof TypeError && /^ops-rollout: no service named "gone"\. Known services: orders-api/.test(error.message));
        await assert.rejects(poll({ ...SPEC, environment: "gone" }), (error: unknown) => error instanceof TypeError && /^ops-rollout: orders-api has no environment "gone"/.test(error.message));
        h.jig.reset();
        await assert.rejects(poll(), /^InputError: ops is not set up: add an "ops" section/);
    });

    test("an environment that has lost its Kubernetes runtime is a failed poll", async () => {
        h.configure(withEnvironment("orders-api", "staging", { deploy: undefined, runtime: undefined, health: "https://orders.staging.example.com/health" }));
        await assert.rejects(poll(), /^Error: orders-api in staging has no Kubernetes runtime in the catalog/);
    });

    test("the state it returns is plain JSON, as the engine saves it", async () => {
        h.cluster.answer(orders("1.4.2"));
        const outcome = await poll();
        assert.deepEqual(JSON.parse(JSON.stringify(outcome.state)), outcome.state);
    });
});
