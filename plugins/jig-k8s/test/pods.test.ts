// The pods of a service: how a pod is read from kubectl's JSON, which pod is the first Ready one, and the `pods` action.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { age, firstReady, listPods, ownContainers, parsePod, podsAction, tagOf } from "../src/pods.ts";
import type { Container } from "../src/pods.ts";
import { fakeClock, NOW } from "./support/clock.ts";
import { IMAGE, list, pod } from "./support/fixtures.ts";
import { rig } from "./support/rig.ts";
import type { Rig } from "./support/rig.ts";

let r: Rig;
beforeEach(() => {
    r = rig();
});
afterEach(() => r.close());

const parse = (raw: unknown, service = "orders-api", environment = "staging") => parsePod(raw, r.target(service, environment));

describe("the tag of an image", () => {
    test("is what follows the last colon after the last slash", () => {
        assert.equal(tagOf("registry.example.test/shop/orders-api:1.4.2"), "1.4.2");
        assert.equal(tagOf("orders-api:latest"), "latest");
        assert.equal(tagOf("registry.example.test:5000/shop/orders-api:1.4.2"), "1.4.2");
        assert.equal(tagOf("registry.example.test:5000/shop/orders-api"), undefined, "a port is not a tag");
        assert.equal(tagOf("orders-api"), undefined);
        assert.equal(tagOf("registry.example.test/shop/orders-api:1.4.2@sha256:abc123"), "1.4.2");
        assert.equal(tagOf("registry.example.test/shop/orders-api@sha256:abc123"), undefined, "a digest is not a tag");
        assert.equal(tagOf(""), undefined);
    });
});

describe("the containers that run the service itself", () => {
    const containers: Container[] = [
        { name: "mesh-proxy", image: "registry.example.test/mesh/proxy:1.20", tag: "1.20" },
        { name: "main", image: "registry.example.test/shop/orders-api:1.4.2", tag: "1.4.2" },
        { name: "worker", image: "registry.example.test/shop/worker:2.0", tag: "2.0" },
    ];

    test("the configured container wins", () => {
        const target = { ...r.target(), container: "worker" };
        assert.deepEqual(ownContainers(containers, target).map((c) => c.name), ["worker"]);
    });

    test("a pod with one container has no sidecar", () => {
        assert.deepEqual(ownContainers(containers.slice(0, 1), { ...r.target(), container: undefined }).map((c) => c.name), ["mesh-proxy"]);
    });

    test("otherwise the container or the image that is named like the service", () => {
        const target = { ...r.target(), container: undefined };
        assert.deepEqual(ownContainers(containers, target).map((c) => c.name), ["main"], "by its image");
        const byName = [...containers.slice(0, 1), { name: "orders-api", image: "registry.example.test/x/y:9", tag: "9" }];
        assert.deepEqual(ownContainers(byName, target).map((c) => c.name), ["orders-api"], "by its name");
    });

    test("when none is named like the service, every container is", () => {
        const target = { ...r.target(), container: undefined, service: "something-else" };
        assert.deepEqual(ownContainers(containers, target).map((c) => c.name), ["mesh-proxy", "main", "worker"]);
    });

    test("a configured container the pod does not have is ignored", () => {
        const target = { ...r.target(), container: "gone" };
        assert.deepEqual(ownContainers(containers, target).map((c) => c.name), ["main"]);
    });
});

describe("a pod read from kubectl's JSON", () => {
    test("a running pod", () => {
        const read = parse(pod("orders-api-0", { created: "2026-10-15T08:55:00Z" }));
        assert.deepEqual(read, {
            name: "orders-api-0",
            ready: true,
            readyContainers: 1,
            totalContainers: 1,
            status: "Running",
            restarts: 0,
            created: Date.parse("2026-10-15T08:55:00Z"),
            terminating: false,
            containers: [{ name: "orders-api", image: IMAGE("1.4.2"), tag: "1.4.2" }],
            initContainers: [],
            tags: ["1.4.2"],
            failing: undefined,
        });
    });

    test("the tag is the service's own, and not a sidecar's", () => {
        const read = parse(pod("orders-api-0", { sidecar: "1.20", tag: "1.4.3" }));
        assert.deepEqual(read?.tags, ["1.4.3"]);
        assert.deepEqual([read?.readyContainers, read?.totalContainers], [2, 2]);
        assert.deepEqual(read?.containers.map((c) => c.tag), ["1.4.3", "1.20"]);
    });

    test("what kubectl would print under STATUS", () => {
        const status = (options: Parameters<typeof pod>[1]) => parse(pod("p", options))?.status;
        assert.equal(status({}), "Running");
        assert.equal(status({ phase: "Pending", ready: false }), "Pending");
        assert.equal(status({ waiting: "CrashLoopBackOff", ready: false }), "CrashLoopBackOff");
        assert.equal(status({ waiting: "ContainerCreating", ready: false, phase: "Pending" }), "ContainerCreating");
        assert.equal(status({ initWaiting: "PodInitializing", ready: false }), "Init:PodInitializing");
        assert.equal(status({ terminated: { reason: "OOMKilled", exitCode: 137 }, ready: false }), "OOMKilled");
        assert.equal(status({ terminated: { reason: "Completed", exitCode: 0 }, phase: "Succeeded", ready: false }), "Succeeded");
        assert.equal(status({ deleting: true, waiting: "CrashLoopBackOff" }), "Terminating", "a pod on its way out says so first");
        assert.equal(status({ phase: "Failed", ready: false }), "Failed");
    });

    test("a reason the pod itself gives, such as Evicted, is its status", () => {
        const raw = pod("p", { phase: "Failed", ready: false }) as { status: Record<string, unknown> };
        raw.status.reason = "Evicted";
        assert.equal(parse(raw)?.status, "Evicted");
    });

    test("restarts add up over the containers", () => {
        const raw = pod("p", { sidecar: "1.20", restarts: 3 }) as { status: { containerStatuses: Array<Record<string, unknown>> } };
        (raw.status.containerStatuses[1] as Record<string, unknown>).restartCount = 4;
        assert.equal(parse(raw)?.restarts, 7);
    });

    test("a pod that cannot come up by itself is failing", () => {
        for (const waiting of ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "InvalidImageName"]) {
            assert.equal(parse(pod("p", { waiting, ready: false }))?.failing, waiting, waiting);
        }
        for (const waiting of ["ContainerCreating", "PodInitializing", "Pending"]) {
            assert.equal(parse(pod("p", { waiting, ready: false }))?.failing, undefined, waiting);
        }
        assert.equal(parse(pod("p", { initWaiting: "ImagePullBackOff", ready: false }))?.failing, "ImagePullBackOff", "an init container too");
    });

    test("a pod being deleted is terminating", () => {
        assert.equal(parse(pod("p", { deleting: true }))?.terminating, true);
        assert.equal(parse(pod("p"))?.terminating, false);
    });

    test("an init container is known by name", () => {
        assert.deepEqual(parse(pod("p", { initContainer: "migrate" }))?.initContainers, ["migrate"]);
    });

    test("anything that is not a pod is skipped, and a pod with little in it still reads", () => {
        for (const raw of [null, undefined, 5, "pod", [], {}, { metadata: {} }, { metadata: { name: "" } }, { metadata: { name: 5 } }]) {
            assert.equal(parse(raw), undefined, JSON.stringify(raw));
        }
        const bare = parse({ metadata: { name: "bare" } });
        assert.deepEqual([bare?.status, bare?.ready, bare?.restarts, bare?.created, bare?.tags, bare?.totalContainers], ["Unknown", false, 0, undefined, [], 0]);
    });

    test("a pod without a tag shows none", () => {
        const read = parse(pod("p", { image: "registry.example.test/shop/orders-api@sha256:abc" }));
        assert.deepEqual(read?.tags, []);
    });
});

describe("the age of a pod", () => {
    test("is shown in the largest unit that has two of it", () => {
        const at = Date.parse("2026-10-15T08:00:00Z");
        const ago = (seconds: number) => age(at, at + seconds * 1000);
        assert.deepEqual([ago(0), ago(119), ago(120), ago(7199), ago(7200), ago(172_799), ago(172_800), ago(5 * 86_400)], ["0s", "119s", "2m", "119m", "2h", "47h", "2d", "5d"]);
        assert.equal(age(undefined, at), "?");
        assert.equal(age(at + 5000, at), "0s", "a clock that is behind does not give a negative age");
    });
});

describe("the first Ready pod", () => {
    const read = (...items: Array<Record<string, unknown>>) => items.map((item) => parse(item)).filter((p) => p !== undefined);

    test("is the first one in the order kubectl listed them that is ready", () => {
        const pods = read(pod("a-0", { ready: false }), pod("a-1"), pod("a-2"));
        assert.equal(firstReady(pods)?.name, "a-1");
    });

    test("is never one that is on its way out, however ready it still looks", () => {
        const pods = read(pod("a-0", { deleting: true }), pod("a-1", { ready: false }), pod("a-2"));
        assert.equal(firstReady(pods)?.name, "a-2");
    });

    test("is nothing when no pod is ready", () => {
        assert.equal(firstReady(read(pod("a-0", { ready: false }), pod("a-1", { deleting: true }))), undefined);
        assert.equal(firstReady([]), undefined);
    });
});

describe("listing the pods", () => {
    test("asks kubectl for the pods that match the selector, as JSON, and reads them in order", async () => {
        r.kubectl.answer({ pods: list(pod("orders-api-1"), pod("orders-api-0"), { not: "a pod" }) });
        const pods = await listPods(r.kube());
        assert.deepEqual(pods.map((p) => p.name), ["orders-api-1", "orders-api-0"]);
        assert.deepEqual(r.kubectl.calls().map((call) => call.argv), [
            ["--request-timeout=25s", "--context=test-cluster", "--namespace=orders-staging", "get", "pods", "--selector=app=orders-api", "-o", "json"],
        ]);
    });

    test("uses the selector of the target, with all its pairs", async () => {
        r.kubectl.answer({ pods: list() });
        await listPods(r.kube(r.target("orders-api", "production")));
        assert.equal(r.kubectl.calls()[0]?.argv[5], "--selector=app=orders-api,tier=web");
    });

    test("a list with no items, or no list at all, is no pods", async () => {
        r.kubectl.answer({ pods: { stdout: { items: [] } } });
        assert.deepEqual(await listPods(r.kube()), []);
        r.kubectl.answer({ pods: { stdout: {} } });
        assert.deepEqual(await listPods(r.kube()), []);
    });
});

describe("the pods action", () => {
    test("one line per pod: ready, status, restarts, age and image tag", async () => {
        r.kubectl.answer({
            pods: list(
                pod("orders-api-0", { created: "2026-10-15T08:55:00Z" }),
                pod("orders-api-1", { ready: false, waiting: "CrashLoopBackOff", restarts: 7, tag: "1.4.3", created: "2026-10-15T08:00:00Z" }),
                pod("orders-api-2", { sidecar: "1.20", created: "2026-10-12T08:00:00Z" }),
            ),
        });
        const outcome = await podsAction(r.kube(), fakeClock().now());
        assert.equal(
            outcome.text,
            [
                "3 pods of orders-api in staging (namespace orders-staging):",
                "- orders-api-0: 1/1 ready, Running, 0 restarts, 5m, image 1.4.2",
                "- orders-api-1: 0/1 ready, CrashLoopBackOff, 7 restarts, 60m, image 1.4.3",
                "- orders-api-2: 2/2 ready, Running, 0 restarts, 3d, image 1.4.2",
            ].join("\n"),
        );
        assert.deepEqual(outcome.facts, { pods: 3, ready: 2 });
        assert.deepEqual((outcome.details.pods as unknown[])[1], { name: "orders-api-1", ready: false, status: "CrashLoopBackOff", restarts: 7, tags: ["1.4.3"] });
    });

    test("says when no pod matches, and what was looked for", async () => {
        r.kubectl.answer({ pods: list() });
        const outcome = await podsAction(r.kube(r.target("billing", "staging")), NOW);
        assert.equal(outcome.text, "No pods match app=billing for billing in staging (namespace billing-staging).");
        assert.deepEqual(outcome.facts, { pods: 0, ready: 0 });
    });

    test("counts a pod that is on its way out as a pod, but not as a ready one", async () => {
        r.kubectl.answer({ pods: list(pod("a-0"), pod("a-1", { deleting: true })) });
        const outcome = await podsAction(r.kube(), NOW);
        assert.match(outcome.text, /^2 pods of /);
        assert.match(outcome.text, /- a-1: 1\/1 ready, Terminating, /);
        assert.deepEqual(outcome.facts, { pods: 2, ready: 1 });
    });

    test("a single pod reads as one", async () => {
        r.kubectl.answer({ pods: list(pod("a-0")) });
        assert.match((await podsAction(r.kube(), NOW)).text, /^1 pod of orders-api in staging/);
    });

    test("a kubectl that fails is one line that says what to do", async () => {
        r.kubectl.answer({ pods: { code: 1, stderr: "Unable to connect to the server: dial tcp: i/o timeout" } });
        await assert.rejects(podsAction(r.kube(), NOW), /^Error: Cannot reach the cluster of context test-cluster for orders-api in staging/);
    });
});
