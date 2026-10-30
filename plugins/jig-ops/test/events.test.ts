// The events action: what the cluster recently said about the service. It reads the service's own objects, then the events of
// the namespace, and keeps the events about those objects.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { MAX_EVENTS } from "../src/runtime/kubernetes/events.ts";
import { event, list, pod, replicaSet, workload } from "./support/fixtures.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

const EVENTS = { action: "events", service: "orders-api", environment: "staging" };
const PREFIX = ["--request-timeout=25s", "--context=test-cluster", "--namespace=orders-staging"];

/** A namespace with the service's objects, and whatever events are given. */
function world(...events: Array<Record<string, unknown>>) {
    h.cluster.answer({
        pods: list(pod("orders-api-0"), pod("orders-api-1")),
        workloads: list(workload("orders-api"), workload("orders-api-batch", { service: "billing" })),
        replicasets: list(
            replicaSet("orders-api-6d4f", { revision: 2 }),
            replicaSet("billing-77c", { service: "billing", owner: "billing" }),
        ),
        events: list(...events),
    });
}

describe("which events are shown", () => {
    test("those about the service's pods, workloads and replica sets, oldest first, with their age and count", async () => {
        world(
            event("orders-api-1", {
                type: "Warning",
                reason: "BackOff",
                message: "Back-off restarting failed container",
                count: 4,
                last: "2026-10-15T08:58:00Z",
            }),
            event("orders-api", {
                kind: "StatefulSet",
                reason: "SuccessfulCreate",
                message: "create Pod orders-api-1 in StatefulSet orders-api successful",
                last: "2026-10-15T08:50:00Z",
            }),
            event("orders-api-6d4f", {
                kind: "ReplicaSet",
                type: "Warning",
                reason: "FailedCreate",
                message: "exceeded quota",
                last: "2026-10-15T08:30:00Z",
            }),
            event("orders-api-0", { reason: "Pulled", last: "2026-10-15T08:59:30Z" }),
        );
        const result = await h.runtime.call(EVENTS);
        assert.equal(
            ok(result),
            [
                "4 events about orders-api in staging (namespace orders-staging), oldest first, 2 warnings:",
                "- 30m ago Warning FailedCreate ReplicaSet/orders-api-6d4f: exceeded quota",
                "- 10m ago Normal SuccessfulCreate StatefulSet/orders-api: create Pod orders-api-1 in StatefulSet orders-api successful",
                "- 2m ago Warning BackOff Pod/orders-api-1: Back-off restarting failed container (x4)",
                "- 30s ago Normal Pulled Pod/orders-api-0: Successfully pulled image",
            ].join("\n"),
        );
        assert.deepEqual(h.jig.facts.get(result.id), [{ events: 4, warnings: 2 }]);
        assert.deepEqual(result.details, { events: 4, warnings: 2, total: 4 });
    });

    test("not those about another service, another namespace object or a pod that does not exist", async () => {
        world(
            event("billing-0", { type: "Warning", reason: "BackOff" }),
            event("orders-api-9", { type: "Warning", reason: "Killing" }),
            event("node-1", { kind: "Node", type: "Warning", reason: "NodeNotReady" }),
            event("billing-77c", { kind: "ReplicaSet", reason: "ScalingReplicaSet" }),
            event("orders-api-batch", { kind: "StatefulSet", reason: "SuccessfulCreate" }),
            event("orders-api-0", { reason: "Started", last: "2026-10-15T08:59:00Z" }),
        );
        const text = ok(await h.runtime.call(EVENTS));
        assert.match(text, /^1 event about orders-api in staging/);
        assert.match(text, /Started Pod\/orders-api-0/);
        for (const other of ["billing", "orders-api-9", "node-1", "orders-api-batch"])
            assert.ok(!text.includes(`/${other}`), other);
    });

    test("a replica set belongs to the service by the labels of its pod template, not by its own", async () => {
        world(
            event("orders-api-6d4f", { kind: "ReplicaSet", reason: "ScalingReplicaSet" }),
            event("elsewhere-1", { kind: "ReplicaSet", reason: "ScalingReplicaSet" }),
        );
        h.cluster.answer({
            pods: list(pod("orders-api-0")),
            workloads: list(),
            replicasets: list(replicaSet("orders-api-6d4f"), replicaSet("elsewhere-1", { labelsOn: "none" })),
            events: list(
                event("orders-api-6d4f", { kind: "ReplicaSet" }),
                event("elsewhere-1", { kind: "ReplicaSet" }),
            ),
        });
        const text = ok(await h.runtime.call(EVENTS));
        assert.match(text, /ReplicaSet\/orders-api-6d4f/);
        assert.ok(!text.includes("elsewhere-1"));
    });

    test("none says so, and that the cluster keeps events for about an hour", async () => {
        world();
        const result = await h.runtime.call(EVENTS);
        assert.equal(
            ok(result),
            "No recent events about the pods and workloads of orders-api in staging (namespace orders-staging). The cluster keeps events for about an hour.",
        );
        assert.deepEqual(h.jig.facts.get(result.id), [{ events: 0, warnings: 0 }]);
    });

    test("only the latest ones, and how many there were", async () => {
        const many = Array.from({ length: MAX_EVENTS + 12 }, (_, n) =>
            event("orders-api-0", {
                reason: `Reason${n}`,
                last: new Date(Date.parse("2026-10-15T08:00:00Z") + n * 1000).toISOString(),
            }),
        );
        world(...many);
        const text = ok(await h.runtime.call(EVENTS));
        const lines = text.split("\n");
        assert.equal(
            lines[0],
            `${MAX_EVENTS} events of ${MAX_EVENTS + 12} about orders-api in staging (namespace orders-staging), oldest first, 0 warnings:`,
        );
        assert.equal(lines.length, MAX_EVENTS + 1);
        assert.match(lines[1] ?? "", /Reason12 /, "the oldest of the latest");
        assert.match(lines[lines.length - 1] ?? "", new RegExp(`Reason${MAX_EVENTS + 11} `), "the newest");
    });
});

describe("when an event happened", () => {
    test("is read from whichever field the API used: the last time, the event time, the series, the first time, the creation", async () => {
        world(
            event("orders-api-0", { reason: "A", last: "2026-10-15T08:59:00Z" }),
            event("orders-api-0", { reason: "B", eventTime: "2026-10-15T08:58:00Z" }),
            event("orders-api-0", {
                reason: "C",
                seriesLast: "2026-10-15T08:57:00Z",
                eventTime: "2026-10-15T08:00:00Z",
            }),
            event("orders-api-0", { reason: "D", first: "2026-10-15T08:56:00Z" }),
            event("orders-api-0", { reason: "E", created: "2026-10-15T08:55:00Z" }),
        );
        const lines = ok(await h.runtime.call(EVENTS))
            .split("\n")
            .slice(1);
        assert.deepEqual(
            lines.map((line) => /ago \w+ (\w+) /.exec(line)?.[1]),
            ["E", "D", "C", "B", "A"],
        );
        assert.deepEqual(
            lines.map((line) => /^- (\w+) ago/.exec(line)?.[1]),
            ["5m", "4m", "3m", "2m", "60s"],
        );
    });

    test("an event with no time at all is shown first, with a question mark for its age", async () => {
        world(
            event("orders-api-0", { reason: "Dated", last: "2026-10-15T08:59:00Z" }),
            event("orders-api-1", { reason: "Undated" }),
        );
        const lines = ok(await h.runtime.call(EVENTS))
            .split("\n")
            .slice(1);
        assert.match(lines[0] ?? "", /^- \? Normal Undated Pod\/orders-api-1/);
    });
});

describe("what the lines hold", () => {
    test("the message is cleaned of terminal sequences and control characters, and cut", async () => {
        world(
            event("orders-api-0", {
                type: "Warning",
                reason: "Failed",
                message: `\u001b[31mred\u001b[0m\u0000 ${"x".repeat(400)}`,
            }),
        );
        const line = ok(await h.runtime.call(EVENTS)).split("\n")[1] ?? "";
        assert.match(line, /^- \? Warning Failed Pod\/orders-api-0: red\? x+…$/);
        assert.ok(line.length < 400);
    });

    test("an event without a kind or a name is skipped", async () => {
        world({ involvedObject: {}, reason: "Odd" }, { reason: "Odder" }, event("orders-api-0", { reason: "Fine" }));
        assert.match(ok(await h.runtime.call(EVENTS)), /^1 event about /);
    });
});

describe("what it asks of the cluster", () => {
    test("reads the pods, the workloads, the replica sets and the events, in that order, and nothing else", async () => {
        world();
        await h.runtime.call(EVENTS);
        assert.deepEqual(
            h.cluster.calls().map((call) => call.argv),
            [
                [...PREFIX, "get", "pods", "--selector=app=orders-api", "-o", "json"],
                [...PREFIX, "get", "deployments,statefulsets", "-o", "json"],
                [...PREFIX, "get", "replicasets", "-o", "json"],
                [...PREFIX, "get", "events", "-o", "json"],
            ],
        );
        assert.deepEqual(h.cluster.helmCalls(), []);
    });

    test("a namespace with more events than can be read says so, and not that the selector matches too much", async () => {
        world();
        h.jig.script = (_file, args) =>
            args[3] === "get" && args[4] === "events"
                ? {
                      code: 0,
                      stdout: `{"items": [\n[output cut at ${8 * 1024 * 1024} bytes]\n`,
                      stderr: "",
                      timedOut: false,
                  }
                : undefined;
        const result = await h.runtime.call(EVENTS);
        assert.equal(
            result.error?.message,
            "kubectl's answer is larger than 8 MiB: the namespace has too many events to read",
        );
    });

    test("a failure reads as it does for the other actions", async () => {
        world();
        h.cluster.answer({
            pods: list(pod("orders-api-0")),
            workloads: list(),
            replicasets: list(),
            events: {
                code: 1,
                stderr: 'Error from server (Forbidden): events is forbidden: User "u" cannot list resource "events" in API group "" in the namespace "orders-staging"',
            },
        });
        assert.match(
            (await h.runtime.call(EVENTS)).error?.message ?? "",
            /^The kubeconfig user is not allowed to read orders-api in staging/,
        );
    });

    test("in production it is a read like the others", async () => {
        world();
        const result = await h.runtime.call({ ...EVENTS, environment: "production" });
        assert.equal(result.cls?.environment, "production");
        assert.equal(result.cls?.effect, "read");
        assert.match(
            ok(result),
            /^No recent events about the pods and workloads of orders-api in production \(namespace orders\)/,
        );
    });
});
