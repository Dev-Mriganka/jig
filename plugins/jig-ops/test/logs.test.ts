// The logs action: which pod and container are read, the limits that reach kubectl, and what the lines look like.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { logsAction } from "../src/runtime/kubernetes/logs.ts";
import type { LogsAsk } from "../src/runtime/kubernetes/logs.ts";
import { list, pod } from "./support/fixtures.ts";
import { rig } from "./support/rig.ts";
import type { Rig } from "./support/rig.ts";

let r: Rig;
beforeEach(() => {
    r = rig();
});
afterEach(() => r.close());

/** What a logs call asks for, as parseCall would make it. */
function ask(more: Partial<LogsAsk> = {}): LogsAsk {
    return { pod: undefined, container: undefined, tail: 200, sinceSeconds: undefined, previous: false, ...more };
}
const read = (more: Partial<LogsAsk> = {}, service = "orders-api", environment = "staging") =>
    logsAction(r.kube(r.target(service, environment)), ask(more));

/** The arguments of the calls kubectl got, after the three that every call starts with. */
const calls = () => r.cluster.calls().map((c) => c.argv.slice(3));

describe("which pod is read", () => {
    test("the first ready pod, when the call names none", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0", { ready: false }), pod("orders-api-1"), pod("orders-api-2")),
            logs: { stdout: "one\ntwo\nthree\n" },
        });
        const outcome = await read();
        assert.deepEqual(calls(), [
            ["get", "pods", "--selector=app=orders-api", "-o", "json"],
            ["logs", "orders-api-1", "-c", "orders-api", "--tail=200"],
        ]);
        assert.equal(outcome.text, "orders-api-1 (container orders-api): 3 lines (tail 200)\none\ntwo\nthree");
        assert.deepEqual(outcome.facts, { lines: 3, previous: false, cut: false });
        assert.deepEqual(outcome.details, { pod: "orders-api-1", container: "orders-api", lines: 3, cut: false });
    });

    test("never one that is on its way out, however ready it looks", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0", { deleting: true }), pod("orders-api-1")),
            logs: { stdout: "x\n" },
        });
        await read();
        assert.equal(calls()[1]?.[1], "orders-api-1");
    });

    test("the pod the call names, ready or not", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0"), pod("orders-api-1", { ready: false, waiting: "CrashLoopBackOff" })),
            logs: { stdout: "boom\n" },
        });
        const outcome = await read({ pod: "orders-api-1", previous: true });
        assert.deepEqual(calls()[1], ["logs", "orders-api-1", "-c", "orders-api", "--tail=200", "--previous"]);
        assert.match(outcome.text, /^orders-api-1 \(container orders-api\): 1 line \(tail 200, previous run\)\nboom$/);
        assert.equal(outcome.facts.previous, true);
    });

    test("a pod that is not a pod of the service is refused, and its logs are never asked for", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0"), pod("orders-api-1")),
            logs: { stdout: "secret from elsewhere\n" },
        });
        await assert.rejects(
            read({ pod: "billing-0" }),
            /^Error: billing-0 is not a pod of orders-api in staging \(use orders-api-0, orders-api-1\)\. Run pods to see them$/,
        );
        assert.deepEqual(
            calls().map((c) => c[0]),
            ["get"],
            "only the pods of the service were listed",
        );
    });

    test("a service with no pods says so when a pod is named", async () => {
        r.cluster.answer({ pods: list() });
        await assert.rejects(read({ pod: "orders-api-0" }), /\(it has no pods\)/);
    });

    test("no ready pod says how to read a crashing one", async () => {
        r.cluster.answer({ pods: list(pod("orders-api-0", { ready: false, waiting: "CrashLoopBackOff" })) });
        await assert.rejects(
            read(),
            /^Error: orders-api has no ready pod in staging to read logs from: run pods, then pass pod \(with previous: true for a crashed container\)$/,
        );
        assert.deepEqual(
            calls().map((c) => c[0]),
            ["get"],
        );
    });
});

describe("which container is read", () => {
    test("the service's own container, not a sidecar", async () => {
        r.cluster.answer({ pods: list(pod("orders-api-0", { sidecar: "1.20" })), logs: { stdout: "x\n" } });
        await read();
        assert.deepEqual(calls()[1], ["logs", "orders-api-0", "-c", "orders-api", "--tail=200"]);
    });

    test("the configured container, when the service's name is not its container's", async () => {
        const raw = pod("orders-api-0", { sidecar: "1.20" }) as {
            spec: { containers: Array<{ name: string; image: string }> };
        };
        raw.spec.containers[0] = { name: "main", image: "registry.example.test/shop/app:1" };
        r.cluster.answer({ pods: list(raw), logs: { stdout: "x\n" } });
        const target = { ...r.target(), container: "main" };
        await logsAction(r.kube(target), ask());
        assert.deepEqual(calls()[1], ["logs", "orders-api-0", "-c", "main", "--tail=200"]);
    });

    test("the only container of a pod, which has no sidecar to be told from", async () => {
        const raw = pod("billing-0") as { spec: { containers: Array<{ name: string; image: string }> } };
        raw.spec.containers[0] = { name: "app", image: "registry.example.test/shop/anything:1" };
        r.cluster.answer({ pods: list(raw), logs: { stdout: "x\n" } });
        await read({}, "billing", "staging");
        assert.deepEqual(calls()[1], ["logs", "billing-0", "-c", "app", "--tail=200"]);
    });

    test("none is named when the service's own cannot be told from the others, and kubectl chooses", async () => {
        const raw = pod("orders-api-0", { sidecar: "1.20" }) as {
            spec: { containers: Array<{ name: string; image: string }> };
        };
        raw.spec.containers[0] = { name: "main", image: "registry.example.test/shop/app:1" };
        r.cluster.answer({ pods: list(raw), logs: { stdout: "x\n" } });
        const outcome = await read({}, "billing", "staging");
        assert.deepEqual(calls()[1], ["logs", "orders-api-0", "--tail=200"]);
        assert.match(
            outcome.text,
            /^orders-api-0 \(kubectl chose the container; the pod has main, mesh-proxy\): 1 line/,
        );
        assert.deepEqual(outcome.details, { pod: "orders-api-0", lines: 1, cut: false });
    });

    test("the container the call names, when the pod has it, an init container too", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0", { sidecar: "1.20", initContainer: "migrate" })),
            logs: { stdout: "x\n" },
        });
        await read({ container: "mesh-proxy" });
        await read({ container: "migrate" });
        assert.deepEqual(
            calls().filter((c) => c[0] === "logs"),
            [
                ["logs", "orders-api-0", "-c", "mesh-proxy", "--tail=200"],
                ["logs", "orders-api-0", "-c", "migrate", "--tail=200"],
            ],
        );
    });

    test("a container the pod does not have is refused with the ones it has, and nothing is read", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0", { sidecar: "1.20", initContainer: "migrate" })),
            logs: { stdout: "x\n" },
        });
        await assert.rejects(
            read({ container: "nope" }),
            /^Error: orders-api-0 has no container nope \(it has orders-api, mesh-proxy, migrate\)$/,
        );
        assert.deepEqual(
            calls().map((c) => c[0]),
            ["get"],
        );
    });
});

describe("the limits that reach kubectl", () => {
    test("the tail, as one argument", async () => {
        r.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: "x\n" } });
        for (const tail of [1, 200, 2000]) await read({ tail });
        assert.deepEqual(
            calls()
                .filter((c) => c[0] === "logs")
                .map((c) => c.find((arg) => arg.startsWith("--tail="))),
            ["--tail=1", "--tail=200", "--tail=2000"],
        );
    });

    test("the window, in seconds", async () => {
        r.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: "x\n" } });
        const outcome = await read({ sinceSeconds: 90, tail: 50 });
        assert.deepEqual(calls()[1], ["logs", "orders-api-0", "-c", "orders-api", "--tail=50", "--since=90s"]);
        assert.match(outcome.text, /\(tail 50, last 90 s\)/);
    });

    test("the previous run, and everything together", async () => {
        r.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: "x\n" } });
        const outcome = await read({
            sinceSeconds: 3600,
            tail: 2000,
            previous: true,
            container: "orders-api",
            pod: "orders-api-0",
        });
        assert.deepEqual(calls()[1], [
            "logs",
            "orders-api-0",
            "-c",
            "orders-api",
            "--tail=2000",
            "--since=3600s",
            "--previous",
        ]);
        assert.match(outcome.text, /\(tail 2000, last 3600 s, previous run\)/);
    });

    test("the call has the time and size limits of a log read", async () => {
        r.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: "x\n" } });
        await read();
        const [, logs] = r.jig.started;
        assert.equal(logs?.options.timeoutMs, 60_000);
        assert.equal(logs?.options.maxOutputBytes, 2 * 1024 * 1024);
        assert.equal(logs?.args[0], "--request-timeout=50s");
    });
});

describe("the lines", () => {
    test("an empty log says so", async () => {
        r.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: "" } });
        const outcome = await read();
        assert.equal(outcome.text, "orders-api-0 (container orders-api): 0 lines (tail 200)\n(no lines)");
        assert.equal(outcome.facts.lines, 0);
    });

    test("colour and cursor codes are removed", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0")),
            logs: { stdout: "\u001b[32mgreen\u001b[0m line\n\u001b[2K\u001b[1Gnext\n" },
        });
        const outcome = await read();
        assert.ok(!outcome.text.includes("\u001b"));
        assert.match(outcome.text, /\ngreen line\nnext$/);
    });

    test("a terminal title or link sequence, and other control characters, do not get through", async () => {
        const hostile =
            "\u001b]0;pwned\u0007visible\u0000\u0007\u001b]8;;http://x.test\u001b\\link\u001b]8;;\u001b\\\u009b31m";
        r.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: `${hostile}\n` } });
        const outcome = await read();
        const body = outcome.text.split("\n").slice(1).join("\n");
        assert.equal(body, "visible??link?31m");
    });

    test("a carriage return, as a progress bar writes, ends a line", async () => {
        r.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: "10%\r50%\r100%\nready\n" } });
        const outcome = await read();
        assert.match(outcome.text, /: 4 lines/);
        assert.match(outcome.text, /\n10%\n50%\n100%\nready$/);
    });

    test("tabs stay, and so do blank lines in the middle", async () => {
        r.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: "a\tb\n\nc\n" } });
        assert.match((await read()).text, /\na\tb\n\nc$/);
    });

    test("a log longer than the limit is cut and says so, without counting the mark as a line", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0")),
            logs: { stdout: "first line\n", extraBytes: 3 * 1024 * 1024 },
        });
        const outcome = await read();
        assert.match(
            outcome.text.split("\n")[0] ?? "",
            /^orders-api-0 \(container orders-api\): 2 lines \(tail 200\), cut at 2 MiB$/,
        );
        assert.ok(!outcome.text.includes("[output cut at"));
        assert.deepEqual([outcome.facts.cut, outcome.details.cut], [true, true]);
    });

    test("the lines are the log's own: nothing is filtered or reordered", async () => {
        const text = Array.from({ length: 300 }, (_, n) => `line ${n}`).join("\n");
        r.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: `${text}\n` } });
        const outcome = await read({ tail: 300 });
        assert.equal(outcome.text.split("\n").length, 301);
        assert.ok(outcome.text.endsWith("line 299"));
    });
});

describe("what goes wrong", () => {
    test("a pod that disappeared between the listing and the read says to list again", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0")),
            logs: { code: 1, stderr: 'Error from server (NotFound): pods "orders-api-0" not found' },
        });
        await assert.rejects(read(), /^Error: The pod is gone: it was replaced after it was listed\. Run pods again$/);
    });

    test("a container waiting to start points to the previous run", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0", { ready: false, waiting: "CrashLoopBackOff" })),
            logs: {
                code: 1,
                stderr: 'Error from server (BadRequest): container "orders-api" in pod "orders-api-0" is waiting to start: CrashLoopBackOff',
            },
        });
        await assert.rejects(
            read({ pod: "orders-api-0" }),
            /try again shortly, or read the log of its last run with previous: true$/,
        );
    });

    test("a pod that never restarted has no previous log", async () => {
        r.cluster.answer({
            pods: list(pod("orders-api-0")),
            logs: {
                code: 1,
                stderr: 'Error from server (BadRequest): previous terminated container "orders-api" in pod "orders-api-0" not found',
            },
        });
        await assert.rejects(
            read({ previous: true }),
            /^Error: The pod has no previous container log: its container has not restarted$/,
        );
    });
});
