// The one place kubectl is built and run: the arguments it gets, what it may be asked to do, its limits and its failures.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { argvOf, CHANGE, cutMark, getJson, LOGS, READ, READS, readKubectl, runKubectl, startKubectl, wasCut, WRITES } from "../src/runtime/kubernetes/kubectl.ts";
import { rig } from "./support/rig.ts";
import type { Rig } from "./support/rig.ts";

let r: Rig;
beforeEach(() => {
    r = rig();
});
afterEach(() => r.close());

describe("the arguments", () => {
    test("start with kubectl's time limit and the context and namespace of the target, then the verb", () => {
        assert.deepEqual(argvOf(r.target(), "get", ["pods", "-o", "json"], READ), [
            "--request-timeout=25s",
            "--context=test-cluster",
            "--namespace=orders-staging",
            "get",
            "pods",
            "-o",
            "json",
        ]);
        assert.deepEqual(argvOf(r.target("orders-api", "production"), "logs", ["orders-api-0"], LOGS).slice(0, 4), [
            "--request-timeout=50s",
            "--context=prod-cluster",
            "--namespace=orders",
            "logs",
        ]);
    });

    test("give a value that starts with a dash no way to be read as a flag: it is part of one argument", () => {
        const target = { ...r.target(), context: "-x", namespace: "--all-namespaces" };
        const argv = argvOf(target, "get", [], READ);
        assert.deepEqual(argv.slice(1, 3), ["--context=-x", "--namespace=--all-namespaces"]);
    });

    test("only three commands read and two change, and each of the two is one word and the word after it", () => {
        assert.deepEqual([...READS], ["get", "logs", "exec"]);
        assert.deepEqual(WRITES.map((write) => `${write.verb} ${write.then}`), ["set image", "rollout undo"]);
    });

    test("a change is built like a read: the same three flags first, then the verb and its words", () => {
        assert.deepEqual(argvOf(r.target(), "set", ["image", "deployment/orders-api", "orders-api=registry.example.test/shop/orders-api:1.4.3"], CHANGE), [
            "--request-timeout=50s",
            "--context=test-cluster",
            "--namespace=orders-staging",
            "set",
            "image",
            "deployment/orders-api",
            "orders-api=registry.example.test/shop/orders-api:1.4.3",
        ]);
    });
});

describe("running kubectl", () => {
    test("starts kubectl by name with exactly those arguments, the limits of the call, and no shell", async () => {
        r.cluster.answer({ pods: { stdout: "ok" } });
        const controller = new AbortController();
        const result = await runKubectl(r.kube(r.target(), controller.signal), "get", ["pods"], READ);
        assert.equal(result.stdout, "ok");
        assert.equal(r.jig.started.length, 1);
        const [started] = r.jig.started;
        assert.equal(started?.file, "kubectl");
        assert.deepEqual(started?.args, ["--request-timeout=25s", "--context=test-cluster", "--namespace=orders-staging", "get", "pods"]);
        assert.equal(started?.options.timeoutMs, 30_000);
        assert.equal(started?.options.maxOutputBytes, 8 * 1024 * 1024);
        assert.equal(started?.options.signal, controller.signal);
        assert.equal(started?.options.input, undefined, "nothing is written to its standard input");
        assert.deepEqual(r.cluster.calls().map((call) => call.argv), [started?.args]);
    });

    test("tells kubectl where the kubeconfig is, when Pi was told, and passes nothing else of its own environment on", async () => {
        r.cluster.answer({ pods: { stdout: "ok" } });
        const saved = process.env.KUBECONFIG;
        const other = process.env.AWS_PROFILE;
        try {
            process.env.KUBECONFIG = "/tmp/some/kubeconfig";
            process.env.AWS_PROFILE = "would-be-a-leak";
            await runKubectl(r.kube(), "get", ["pods"], READ);
            delete process.env.KUBECONFIG;
            await runKubectl(r.kube(), "get", ["pods"], READ);
        } finally {
            if (saved === undefined) delete process.env.KUBECONFIG;
            else process.env.KUBECONFIG = saved;
            if (other === undefined) delete process.env.AWS_PROFILE;
            else process.env.AWS_PROFILE = other;
        }
        assert.deepEqual(r.cluster.calls().map((call) => call.kubeconfig), ["/tmp/some/kubeconfig", undefined]);
        assert.deepEqual(r.jig.started.map((started) => started.options.env), [{ KUBECONFIG: "/tmp/some/kubeconfig" }, {}]);
    });

    test("refuses a command that is not on the lists before anything starts", async () => {
        const refused: Array<[string, string[]]> = [
            ...["delete", "scale", "apply", "edit", "port-forward", "cp", "patch", "replace", "create", "run", "attach", "label", "annotate", "drain", "cordon", "taint", "auth", "config", "proxy", "debug", "expose", "autoscale"].map((verb): [string, string[]] => [verb, []]),
            // The two verbs that can change something are allowed only with the word that makes them what they are.
            ["set", []], ["set", ["env", "deployment/orders-api", "A=b"]], ["set", ["resources", "deployment/orders-api"]], ["set", ["serviceaccount", "x", "y"]],
            ["rollout", []], ["rollout", ["restart", "deployment/orders-api"]], ["rollout", ["pause", "deployment/orders-api"]], ["rollout", ["status", "deployment/orders-api"]],
        ];
        for (const [verb, args] of refused) {
            const what = [verb, args[0]].filter((word) => word !== undefined).join(" ");
            for (const start of [runKubectl, startKubectl]) {
                await assert.rejects(start(r.kube(), verb as never, args, READ), (error: Error) => {
                    assert.equal(error.message, `kubectl ${what} is not allowed: the tools run only get, logs, exec, set image and rollout undo`);
                    return true;
                });
            }
        }
        assert.equal(r.jig.started.length, 0);
    });

    test("starts the two changes with the three flags of the target, and a timeout is a result and not an error", async () => {
        r.cluster.answer({ setImage: { stdout: "deployment.apps/orders-api image updated\n" }, rolloutUndo: { stdout: "late", delayMs: 3000 } });
        const done = await startKubectl(r.kube(), "set", ["image", "deployment/orders-api", "orders-api=registry.example.test/shop/orders-api:1.4.3"], CHANGE);
        assert.equal(done.code, 0);
        assert.deepEqual(r.cluster.calls()[0]?.argv.slice(0, 5), ["--request-timeout=50s", "--context=test-cluster", "--namespace=orders-staging", "set", "image"]);
        const late = await startKubectl(r.kube(), "rollout", ["undo", "deployment/orders-api"], { ...CHANGE, timeoutMs: 150 });
        assert.equal(late.timedOut, true);
        await assert.rejects(runKubectl(r.kube(), "rollout", ["undo", "deployment/orders-api"], { ...CHANGE, timeoutMs: 150 }), /^Error: kubectl rollout timed out after 0\.15 s: the cluster is slow or unreachable$/);
    });

    test("a command that runs out of time is an error that says how long it had", async () => {
        r.cluster.answer({ pods: { stdout: "late", delayMs: 3000 } });
        await assert.rejects(
            runKubectl(r.kube(), "get", ["pods"], { ...READ, timeoutMs: 150 }),
            /^Error: kubectl get timed out after 0\.15 s: the cluster is slow or unreachable$/,
        );
    });

    test("a stopped call stops kubectl", async () => {
        r.cluster.answer({ pods: { stdout: "late", delayMs: 3000 } });
        const controller = new AbortController();
        const running = runKubectl(r.kube(r.target(), controller.signal), "get", ["pods"], READ);
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(running, /kubectl was aborted/);
    });

    test("output beyond the limit is cut, and the cut can be told", async () => {
        r.cluster.answer({ logs: { stdout: "start\n", extraBytes: 5000 } });
        const result = await runKubectl(r.kube(), "logs", ["orders-api-0"], { ...LOGS, maxBytes: 1000 });
        assert.equal(wasCut(result.stdout, 1000), true);
        assert.ok(result.stdout.startsWith("start\nxxx"));
        assert.ok(result.stdout.endsWith(cutMark(1000)));
        assert.equal(cutMark(1000), "\n[output cut at 1000 bytes]\n");
        assert.equal(wasCut("fine", 1000), false);
    });
});

describe("reading what kubectl prints", () => {
    test("readKubectl gives the output of a command that worked", async () => {
        r.cluster.answer({ logs: { stdout: "line one\nline two\n" } });
        assert.equal(await readKubectl(r.kube(), "logs", ["orders-api-0"], LOGS), "line one\nline two\n");
    });

    test("a command that failed is one line that says what to do", async () => {
        r.cluster.answer({ logs: { code: 1, stderr: "Error from server (Forbidden): pods is forbidden: User cannot get resource\n" } });
        await assert.rejects(
            readKubectl(r.kube(), "logs", ["orders-api-0"], LOGS),
            /^Error: The kubeconfig user is not allowed to read orders-api in staging \(Error from server \(Forbidden\)/,
        );
    });

    test("getJson asks for JSON and parses it", async () => {
        r.cluster.answer({ pods: { stdout: { items: [{ metadata: { name: "a" } }] } } });
        assert.deepEqual(await getJson(r.kube(), "pods", ["--selector=app=orders-api"]), { items: [{ metadata: { name: "a" } }] });
        assert.deepEqual(r.cluster.calls()[0]?.argv.slice(3), ["get", "pods", "--selector=app=orders-api", "-o", "json"]);
    });

    test("getJson says when the output is not JSON, and when it was too big to be", async () => {
        r.cluster.answer({ pods: { stdout: "<html>nope</html>" } });
        await assert.rejects(getJson(r.kube(), "pods"), /^Error: kubectl returned output that is not JSON: report it to the user$/);
        r.jig.script = () => ({ code: 0, stdout: `{"items": [${cutMark(READ.maxBytes)}`, stderr: "", timedOut: false });
        await assert.rejects(getJson(r.kube(), "pods"), /^Error: kubectl's answer is larger than 8 MiB: the selector matches too much$/);
    });

    test("a kubectl that is not installed is reported as it is", async () => {
        r.jig.script = () => new Error("kubectl is not installed or not on PATH");
        await assert.rejects(getJson(r.kube(), "pods"), /^Error: kubectl is not installed or not on PATH$/);
    });
});
