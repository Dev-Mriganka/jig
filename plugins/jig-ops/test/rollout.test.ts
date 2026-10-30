// The rollout of a service: the workloads behind the pods, the verdict, and waiting until a version is running.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readOps } from "../src/catalog.ts";
import { parsePod } from "../src/runtime/kubernetes/pods.ts";
import type { Pod } from "../src/runtime/kubernetes/pods.ts";
import { evaluate, parseWorkloads, podLines, verdictLine, workloadLines } from "../src/runtime/kubernetes/rollout.ts";
import { nextDelay, POLL_FIRST_MS, POLL_MAX_MS, rolloutAction } from "../src/runtime/kubernetes/wait.ts";
import type { RolloutAsk } from "../src/runtime/kubernetes/wait.ts";
import { fakeClock, NOW } from "./support/clock.ts";
import type { FakeClock } from "./support/clock.ts";
import { list, pod, workload } from "./support/fixtures.ts";
import { rig } from "./support/rig.ts";
import type { Rig } from "./support/rig.ts";
import { section } from "./support/section.ts";

let r: Rig;
let clock: FakeClock;
beforeEach(() => {
    r = rig();
    clock = fakeClock();
});
afterEach(() => r.close());

// The parsing and the verdict need no cluster, so their tests read the target straight from the section.
const TARGET = readOps(section()).catalog?.services.get("orders-api")?.environments.get("staging")?.kubernetes;
if (TARGET === undefined) throw new Error("the default section has no orders-api in staging");
const target = () => TARGET;
const pods = (...items: Array<Record<string, unknown>>): Pod[] =>
    items.map((item) => parsePod(item, target())).filter((p): p is Pod => p !== undefined);
const workloads = (...items: Array<Record<string, unknown>>) => parseWorkloads({ items }, target());

/** What a rollout call asks for, as parseCall would make it. */
function ask(waitFor?: string, timeoutSec = 300): RolloutAsk {
    return { waitFor, timeoutSec };
}
const run = (waitFor?: string, timeoutSec?: number) => rolloutAction(r.kube(), ask(waitFor, timeoutSec), clock.deps);

/** Pods that are all ready on one tag. */
const rolled = (tag: string, count = 2) =>
    list(...Array.from({ length: count }, (_, n) => pod(`orders-api-${n}`, { tag, created: "2026-10-15T08:55:00Z" })));

describe("the workloads behind the pods", () => {
    test("a statefulset: its counters, its revision and the tag it asks for", () => {
        const [found] = workloads(workload("orders-api", { tag: "1.4.3", ready: 1, updated: 2 }));
        assert.deepEqual(found, {
            kind: "StatefulSet",
            name: "orders-api",
            desired: 2,
            ready: 1,
            updated: 2,
            revision: "orders-api-5d9f",
            tags: ["1.4.3"],
        });
    });

    test("a statefulset that is rolling shows both revisions", () => {
        const [found] = workloads(
            workload("orders-api", { currentRevision: "orders-api-5d9f", updateRevision: "orders-api-7c1a" }),
        );
        assert.equal(found?.revision, "orders-api-5d9f -> orders-api-7c1a");
    });

    test("a deployment: its revision is the one it is annotated with", () => {
        const [found] = workloads(workload("orders-api", { kind: "Deployment", deploymentRevision: "12" }));
        assert.deepEqual([found?.kind, found?.revision], ["Deployment", "12"]);
        assert.equal(workloads(workload("orders-api", { kind: "Deployment" }))[0]?.revision, undefined);
    });

    test("a workload with no replicas runs one", () => {
        assert.equal(workloads(workload("orders-api", { replicas: null }))[0]?.desired, 1);
        assert.equal(workloads(workload("orders-api", { replicas: 0 }))[0]?.desired, 0, "scaled to zero is not one");
    });

    test("belongs to the service when its selector or its pod template carries the labels of the target", () => {
        assert.equal(workloads(workload("a", { labelsOn: "selector" })).length, 1);
        assert.equal(workloads(workload("a", { labelsOn: "template" })).length, 1);
        assert.equal(workloads(workload("a", { labelsOn: "none" })).length, 0);
        assert.equal(workloads(workload("other", { service: "billing" })).length, 0, "another service's workload");
    });

    test("needs every pair of a selector with several", () => {
        const both = parseWorkloads({ items: [workload("a")] }, r.target("orders-api", "production"));
        assert.deepEqual(both, [], "app=orders-api alone does not carry tier=web");
        const item = workload("a") as { spec: { selector: { matchLabels: Record<string, string> } } };
        item.spec.selector.matchLabels.tier = "web";
        assert.equal(parseWorkloads({ items: [item] }, r.target("orders-api", "production")).length, 1);
    });

    test("skips kinds it does not know, and anything that is not a workload", () => {
        const daemon = { ...workload("a"), kind: "DaemonSet" };
        assert.deepEqual(
            workloads(daemon, { nope: 1 }, null as never, { kind: "Deployment", metadata: {} } as never),
            [],
        );
        assert.deepEqual(parseWorkloads(null, target()), []);
        assert.deepEqual(parseWorkloads({}, target()), []);
    });

    test("two workloads for one service are both read", () => {
        assert.equal(workloads(workload("a"), workload("b", { kind: "Deployment" })).length, 2);
    });

    test("workloadLines says what runs the pods, or that nothing found does", () => {
        assert.equal(
            workloadLines(workloads(workload("orders-api", { currentRevision: "r1", updateRevision: "r2", ready: 1 }))),
            "Workload: StatefulSet orders-api, 1/2 ready, 2 updated, revision r1 -> r2, image 1.4.2.",
        );
        assert.equal(
            workloadLines([]),
            "Workload: no deployment or statefulset runs these pods; judged from the pods.",
        );
    });
});

describe("the verdict", () => {
    const two = workloads(workload("orders-api"));

    test("running: as many pods as wanted, all ready, all on the version", () => {
        const rollout = evaluate(pods(pod("a-0", { tag: "1.4.3" }), pod("a-1", { tag: "1.4.3" })), two, "1.4.3");
        assert.deepEqual(
            [rollout.verdict, rollout.settled, rollout.wanted, rollout.tags],
            ["running", 2, 2, ["1.4.3"]],
        );
    });

    test("rolling: a pod is not on the version yet, or not ready", () => {
        assert.equal(
            evaluate(pods(pod("a-0", { tag: "1.4.3" }), pod("a-1", { tag: "1.4.2" })), two, "1.4.3").verdict,
            "rolling",
        );
        assert.equal(
            evaluate(pods(pod("a-0", { tag: "1.4.3" }), pod("a-1", { tag: "1.4.3", ready: false })), two, "1.4.3")
                .verdict,
            "rolling",
        );
        assert.equal(
            evaluate(pods(pod("a-0", { tag: "1.4.2" }), pod("a-1", { tag: "1.4.2" })), two, "1.4.3").verdict,
            "rolling",
            "ready, but on the old version",
        );
    });

    test("rolling: fewer pods than the workload wants, even if each is fine", () => {
        assert.equal(evaluate(pods(pod("a-0", { tag: "1.4.3" })), two, "1.4.3").verdict, "rolling");
    });

    test("rolling: a surge pod of the old version is still there", () => {
        const surge = pods(pod("a-0", { tag: "1.4.3" }), pod("a-1", { tag: "1.4.3" }), pod("a-2", { tag: "1.4.2" }));
        const rollout = evaluate(surge, two, "1.4.3");
        assert.deepEqual([rollout.verdict, rollout.settled, rollout.live.length], ["rolling", 2, 3]);
    });

    test("a pod on its way out counts for nothing, either way", () => {
        const going = pods(
            pod("a-0", { tag: "1.4.3" }),
            pod("a-1", { tag: "1.4.3" }),
            pod("old", { tag: "1.4.2", deleting: true }),
        );
        assert.equal(evaluate(going, two, "1.4.3").verdict, "running", "it does not hold the rollout back");
        const lone = pods(pod("a-0", { tag: "1.4.3" }), pod("old", { tag: "1.4.3", deleting: true }));
        assert.equal(
            evaluate(lone, two, "1.4.3").verdict,
            "rolling",
            "and it does not count as one of the wanted pods",
        );
    });

    test("failing: a pod waits for a reason that does not pass, whatever the other pods do", () => {
        for (const waiting of ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull"]) {
            const rollout = evaluate(
                pods(pod("a-0", { tag: "1.4.3" }), pod("a-1", { tag: "1.4.3", ready: false, waiting, restarts: 3 })),
                two,
                "1.4.3",
            );
            assert.equal(rollout.verdict, "failing", waiting);
            assert.equal(rollout.failing?.name, "a-1");
        }
        assert.equal(
            evaluate(pods(pod("a-0", { ready: false, waiting: "CrashLoopBackOff", deleting: true })), two, "1.4.3")
                .verdict,
            "no-pods",
            "but not one that is going away",
        );
    });

    test("no pods: nothing is running", () => {
        assert.equal(evaluate([], two, "1.4.3").verdict, "no-pods");
        assert.equal(evaluate([], [], undefined).verdict, "no-pods");
        assert.equal(evaluate(pods(pod("a-0", { deleting: true })), two, undefined).verdict, "no-pods");
    });

    test("with no workload found it judges from the pods: one pod is enough, none is not", () => {
        assert.equal(evaluate(pods(pod("a-0", { tag: "1.4.3" })), [], "1.4.3").verdict, "running");
        assert.equal(
            evaluate(pods(pod("a-0", { tag: "1.4.3" }), pod("a-1", { tag: "1.4.2" })), [], "1.4.3").verdict,
            "rolling",
        );
    });

    test("a service scaled to zero is not running", () => {
        assert.equal(evaluate([], workloads(workload("orders-api", { replicas: 0 })), "1.4.3").verdict, "no-pods");
    });

    test("with no version to wait for, the pods only have to be ready and to agree", () => {
        assert.equal(
            evaluate(pods(pod("a-0", { tag: "1.4.2" }), pod("a-1", { tag: "1.4.2" })), two, undefined).verdict,
            "running",
        );
        assert.equal(
            evaluate(pods(pod("a-0", { tag: "1.4.2" }), pod("a-1", { tag: "1.4.3" })), two, undefined).verdict,
            "rolling",
        );
        assert.equal(
            evaluate(pods(pod("a-0", { tag: "1.4.2" }), pod("a-1", { tag: "1.4.2", ready: false })), two, undefined)
                .verdict,
            "rolling",
        );
    });

    test("a sidecar's version is not the service's: the tag compared is the service's own", () => {
        const rollout = evaluate(
            pods(pod("a-0", { tag: "1.4.3", sidecar: "1.20" }), pod("a-1", { tag: "1.4.3", sidecar: "1.21" })),
            two,
            "1.4.3",
        );
        assert.equal(rollout.verdict, "running");
    });

    test("the sentence for each verdict", () => {
        const sentence = (items: Pod[], version: string | undefined, waited?: string) =>
            verdictLine(evaluate(items, two, version), target(), version, waited);
        assert.equal(sentence(pods(pod("a-0"), pod("a-1")), "1.4.2"), "Running: 2 of 2 pods ready on 1.4.2.");
        assert.equal(sentence(pods(pod("a-0"), pod("a-1")), undefined), "Running: 2 of 2 pods ready on 1.4.2.");
        assert.equal(
            sentence(pods(pod("a-0", { tag: "1.4.3" }), pod("a-1")), "1.4.3"),
            "Still rolling: 1 of 2 pods ready on 1.4.3; pods run 1.4.3, 1.4.2.",
        );
        assert.equal(
            sentence(pods(pod("a-0", { tag: "1.4.3" }), pod("a-1")), "1.4.3", "5m00s"),
            "Still rolling after waiting 5m00s: 1 of 2 pods ready on 1.4.3; pods run 1.4.3, 1.4.2.",
        );
        assert.equal(
            sentence(pods(pod("a-0", { tag: "1.4.3" }), pod("a-1")), undefined),
            "Still rolling: 2 of 2 pods ready; pods run 1.4.3, 1.4.2.",
        );
        assert.equal(
            sentence(pods(pod("a-0"), pod("a-1", { ready: false, waiting: "ImagePullBackOff", restarts: 0 })), "1.4.2"),
            "Failing: pod a-1 is ImagePullBackOff (0 restarts). Read why with runtime logs (pod: a-1, previous: true).",
        );
        assert.equal(sentence([], "1.4.2"), "No pods match app=orders-api in namespace orders-staging.");
        assert.equal(
            sentence([], "1.4.2", "1m00s"),
            "No pods after waiting 1m00s match app=orders-api in namespace orders-staging.",
        );
        assert.equal(
            sentence(pods(pod("a-0", { image: "registry.example.test/shop/orders-api@sha256:abc" })), undefined),
            "Still rolling: 1 of 2 pods ready; pods run no tag.",
        );
    });

    test("podLines marks the pods that are behind, when there is a version to be on", () => {
        const items = pods(
            pod("a-0", { tag: "1.4.3", created: "2026-10-15T08:55:00Z" }),
            pod("a-1", { tag: "1.4.2", created: "2026-10-15T08:55:00Z" }),
            pod("a-2", { tag: "1.4.2", deleting: true, created: "2026-10-15T08:55:00Z" }),
        );
        assert.equal(
            podLines(items, "1.4.3", NOW),
            [
                "- a-0: 1/1 ready, Running, 0 restarts, 5m, image 1.4.3",
                "- a-1: 1/1 ready, Running, 0 restarts, 5m, image 1.4.2  <- not ready on 1.4.3",
                "- a-2: 1/1 ready, Terminating, 0 restarts, 5m, image 1.4.2",
            ].join("\n"),
        );
        assert.ok(!podLines(items, undefined, NOW).includes("<-"));
    });
});

describe("the poll schedule", () => {
    test("starts at 2 seconds, grows by half each time, and stops growing at 15", () => {
        const delays = [POLL_FIRST_MS];
        for (let n = 0; n < 8; n++) delays.push(nextDelay(delays[delays.length - 1] as number));
        assert.deepEqual(delays, [2000, 3000, 4500, 6750, 10_125, 15_000, 15_000, 15_000, 15_000]);
        assert.equal(POLL_MAX_MS, 15_000);
    });
});

describe("rollout without a version to wait for", () => {
    test("says what runs, from the workload and the pods", async () => {
        r.cluster.answer({ pods: rolled("1.4.2"), workloads: list(workload("orders-api")) });
        const outcome = await run();
        assert.equal(
            outcome.text,
            [
                "orders-api in staging (namespace orders-staging): Running: 2 of 2 pods ready on 1.4.2.",
                "Workload: StatefulSet orders-api, 2/2 ready, 2 updated, revision orders-api-5d9f, image 1.4.2.",
                "- orders-api-0: 1/1 ready, Running, 0 restarts, 5m, image 1.4.2",
                "- orders-api-1: 1/1 ready, Running, 0 restarts, 5m, image 1.4.2",
            ].join("\n"),
        );
        assert.deepEqual(outcome.facts, { verdict: "running", pods: 2, ready: 2, polls: 1, timedOut: false });
        assert.deepEqual(clock.sleeps, [], "it looks once");
    });

    test("reads the pods and then the workloads, and nothing else", async () => {
        r.cluster.answer({ pods: rolled("1.4.2"), workloads: list(workload("orders-api")) });
        await run();
        assert.deepEqual(
            r.cluster.calls().map((c) => c.argv.slice(3)),
            [
                ["get", "pods", "--selector=app=orders-api", "-o", "json"],
                ["get", "deployments,statefulsets", "-o", "json"],
            ],
        );
    });

    test("a rollout in progress shows which pods are on which version", async () => {
        r.cluster.answer({
            pods: list(
                pod("orders-api-0", { tag: "1.4.3", created: "2026-10-15T08:55:00Z" }),
                pod("orders-api-1", { tag: "1.4.2", created: "2026-10-15T08:00:00Z" }),
            ),
            workloads: list(
                workload("orders-api", { tag: "1.4.3", currentRevision: "r1", updateRevision: "r2", updated: 1 }),
            ),
        });
        const outcome = await run();
        assert.match(
            outcome.text,
            /^orders-api in staging \(namespace orders-staging\): Still rolling: 2 of 2 pods ready; pods run 1\.4\.3, 1\.4\.2\.$/m,
        );
        assert.match(
            outcome.text,
            /^Workload: StatefulSet orders-api, 2\/2 ready, 1 updated, revision r1 -> r2, image 1\.4\.3\.$/m,
        );
    });

    test("a crash looping pod is named, with the next step", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0", { ready: false, waiting: "CrashLoopBackOff", restarts: 5 })),
            workloads: list(workload("orders-api")),
        });
        const outcome = await run();
        assert.match(
            outcome.text.split("\n")[0] ?? "",
            /Failing: pod orders-api-0 is CrashLoopBackOff \(5 restarts\)\. Read why with runtime logs \(pod: orders-api-0, previous: true\)\.$/,
        );
        assert.equal(outcome.facts.verdict, "failing");
    });

    test("no pods, and no workload", async () => {
        r.cluster.answer({ pods: list(), workloads: list() });
        const outcome = await run();
        assert.equal(
            outcome.text,
            "orders-api in staging (namespace orders-staging): No pods match app=orders-api in namespace orders-staging.\nWorkload: no deployment or statefulset runs these pods; judged from the pods.",
        );
    });

    test("a workload that cannot be read is an error with the reason, not a guess", async () => {
        r.cluster.answer({
            pods: rolled("1.4.2"),
            workloads: {
                code: 1,
                stderr: 'Error from server (Forbidden): deployments.apps is forbidden: User "u" cannot list resource "deployments"',
            },
        });
        await assert.rejects(run(), /^Error: The kubeconfig user is not allowed to read orders-api in staging/);
    });
});

describe("waiting for a version", () => {
    test("returns running at once when the version is already there, without a sleep", async () => {
        r.cluster.answer({ pods: rolled("1.4.3"), workloads: list(workload("orders-api", { tag: "1.4.3" })) });
        const outcome = await run("1.4.3");
        assert.match(
            outcome.text,
            /^orders-api in staging \(namespace orders-staging\): Running: 2 of 2 pods ready on 1\.4\.3\.\n/,
        );
        assert.deepEqual(clock.sleeps, []);
        assert.deepEqual(outcome.facts, { verdict: "running", pods: 2, ready: 2, polls: 1, timedOut: false });
    });

    test("polls with a growing delay until the version is running, and says how it goes", async () => {
        r.cluster.answer({
            pods: [
                list(pod("orders-api-0", { tag: "1.4.2" }), pod("orders-api-1", { tag: "1.4.2" })),
                list(pod("orders-api-0", { tag: "1.4.3" }), pod("orders-api-1", { tag: "1.4.2", ready: false })),
                list(pod("orders-api-0", { tag: "1.4.3" }), pod("orders-api-1", { tag: "1.4.3" })),
            ],
            workloads: list(workload("orders-api", { tag: "1.4.3" })),
        });
        const outcome = await run("1.4.3");
        assert.deepEqual(clock.sleeps, [2000, 3000]);
        assert.deepEqual(clock.progress, [
            "orders-api staging: 0 of 2 ready on 1.4.3, running 1.4.2",
            "orders-api staging: 1 of 2 ready on 1.4.3, running 1.4.3, 1.4.2",
        ]);
        assert.match(outcome.text.split("\n")[0] ?? "", /Running: 2 of 2 pods ready on 1\.4\.3\.$/);
        assert.deepEqual(outcome.facts, { verdict: "running", pods: 2, ready: 2, polls: 3, timedOut: false });
        assert.equal(r.cluster.calls().filter((c) => c.argv[3] === "get" && c.argv[4] === "pods").length, 3);
    });

    test("is still rolling when the time is up, and says how far it got", async () => {
        r.cluster.answer({ pods: rolled("1.4.2"), workloads: list(workload("orders-api")) });
        const outcome = await run("1.4.3", 10);
        assert.deepEqual(clock.sleeps, [2000, 3000, 4500, 500], "the last sleep is cut to the time that is left");
        assert.equal(
            clock.sleeps.reduce((a, b) => a + b, 0),
            10_000,
        );
        assert.match(
            outcome.text.split("\n")[0] ?? "",
            /Still rolling after waiting 10s: 0 of 2 pods ready on 1\.4\.3; pods run 1\.4\.2\.$/,
        );
        assert.match(outcome.text, /- orders-api-0: .* <- not ready on 1\.4\.3/);
        assert.deepEqual(outcome.facts, { verdict: "rolling", pods: 2, ready: 0, polls: 5, timedOut: true });
        assert.equal(outcome.details.timedOut, true);
    });

    test("looks one last time at the deadline: a version that arrives in the last moment is seen", async () => {
        const olds = list(pod("orders-api-0", { tag: "1.4.2" }), pod("orders-api-1", { tag: "1.4.2" }));
        r.cluster.answer({
            pods: [olds, olds, olds, olds, rolled("1.4.3")],
            workloads: list(workload("orders-api", { tag: "1.4.3" })),
        });
        const outcome = await run("1.4.3", 10);
        assert.deepEqual(clock.sleeps, [2000, 3000, 4500, 500]);
        assert.match(outcome.text.split("\n")[0] ?? "", /Running: 2 of 2 pods ready on 1\.4\.3\.$/);
        assert.equal(outcome.facts.timedOut, false);
    });

    test("the shortest wait is one second", async () => {
        r.cluster.answer({ pods: rolled("1.4.2"), workloads: list(workload("orders-api")) });
        const outcome = await run("1.4.3", 1);
        assert.deepEqual(clock.sleeps, [1000]);
        assert.match(outcome.text.split("\n")[0] ?? "", /Still rolling after waiting 1s:/);
    });

    test("the longest wait is ten minutes, polled less and less often, and ends at the limit", async () => {
        r.cluster.answer({ pods: rolled("1.4.2"), workloads: list(workload("orders-api")) });
        await run("1.4.3", 600);
        assert.deepEqual(clock.sleeps.slice(0, 8), [2000, 3000, 4500, 6750, 10_125, 15_000, 15_000, 15_000]);
        assert.equal(
            clock.sleeps.reduce((a, b) => a + b, 0),
            600_000,
        );
        assert.ok(clock.sleeps.every((ms) => ms <= POLL_MAX_MS));
        assert.ok(clock.sleeps.length < 50, `${clock.sleeps.length} polls in ten minutes`);
    });

    test("ends at once, as a result, when a pod cannot come up", async () => {
        for (const waiting of ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull"]) {
            clock = fakeClock();
            r.cluster.answer({
                pods: list(
                    pod("orders-api-0", { tag: "1.4.3" }),
                    pod("orders-api-1", { tag: "1.4.3", ready: false, waiting, restarts: 3 }),
                ),
                workloads: list(workload("orders-api", { tag: "1.4.3" })),
            });
            const outcome = await run("1.4.3");
            assert.deepEqual(clock.sleeps, [], waiting);
            assert.match(
                outcome.text.split("\n")[0] ?? "",
                new RegExp(`Failing: pod orders-api-1 is ${waiting} \\(3 restarts\\)\\.`),
                waiting,
            );
            assert.equal(outcome.facts.verdict, "failing");
        }
    });

    test("ends as a result when a pod starts failing in the middle of the rollout", async () => {
        r.cluster.answer({
            pods: [
                rolled("1.4.2"),
                list(
                    pod("orders-api-0", { tag: "1.4.3", ready: false, waiting: "ImagePullBackOff" }),
                    pod("orders-api-1", { tag: "1.4.2" }),
                ),
            ],
            workloads: list(workload("orders-api", { tag: "1.4.3" })),
        });
        const outcome = await run("1.4.3");
        assert.deepEqual(clock.sleeps, [2000]);
        assert.match(outcome.text, /Failing: pod orders-api-0 is ImagePullBackOff/);
    });

    test("keeps waiting while there are no pods, as they may yet appear", async () => {
        r.cluster.answer({
            pods: [list(), list(), rolled("1.4.3")],
            workloads: list(workload("orders-api", { tag: "1.4.3" })),
        });
        const outcome = await run("1.4.3");
        assert.deepEqual(clock.sleeps, [2000, 3000]);
        assert.match(outcome.text.split("\n")[0] ?? "", /Running:/);
        assert.deepEqual(clock.progress[0], "orders-api staging: 0 of 2 ready on 1.4.3, running no tag");
    });

    test("a kubectl failure during the wait ends it with the line that says what to do", async () => {
        r.cluster.answer({
            pods: [rolled("1.4.2"), { code: 1, stderr: "Unable to connect to the server: dial tcp: i/o timeout" }],
            workloads: list(workload("orders-api")),
        });
        await assert.rejects(
            run("1.4.3"),
            /^Error: Cannot reach the cluster of context test-cluster for orders-api in staging/,
        );
        assert.deepEqual(clock.sleeps, [2000]);
    });

    test("the user stopping the wait ends it with an error that says the rollout goes on", async () => {
        const controller = new AbortController();
        r.cluster.answer({ pods: rolled("1.4.2"), workloads: list(workload("orders-api")) });
        clock.afterSleep = (count) => {
            if (count === 2) controller.abort();
        };
        await assert.rejects(
            rolloutAction(r.kube(r.target(), controller.signal), ask("1.4.3"), clock.deps),
            /^Error: runtime rollout: the wait was stopped \(last seen: rolling, 0 of 2 ready\)\. The rollout itself is not affected: run rollout with waitFor to wait again$/,
        );
        assert.deepEqual(clock.sleeps, [2000, 3000]);
    });

    test("a call stopped before anything was read says so", async () => {
        const controller = new AbortController();
        controller.abort();
        r.cluster.answer({ pods: rolled("1.4.2"), workloads: list(workload("orders-api")) });
        r.jig.script = () => new Error("kubectl was aborted");
        await assert.rejects(
            rolloutAction(r.kube(r.target(), controller.signal), ask("1.4.3"), clock.deps),
            /^Error: runtime rollout: the wait was stopped\. The rollout itself is not affected/,
        );
    });

    test("a stop that kills a kubectl call in the middle of a poll is a stopped wait, not a kubectl failure", async () => {
        const controller = new AbortController();
        r.cluster.answer({
            pods: [rolled("1.4.2"), { stdout: "late", delayMs: 3000 }],
            workloads: list(workload("orders-api")),
        });
        clock.afterSleep = () => setTimeout(() => controller.abort(), 100);
        await assert.rejects(
            rolloutAction(r.kube(r.target(), controller.signal), ask("1.4.3"), clock.deps),
            /^Error: runtime rollout: the wait was stopped \(last seen: rolling, 0 of 2 ready\)/,
        );
    });
});
