// The one place kubectl is built and run: the arguments it gets, what it may be asked to do, its limits and its failures.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { argvOf, cutMark, getJson, LOGS, READ, readKubectl, runKubectl, VERBS, wasCut } from "../src/kubectl.ts";
import type { Verb } from "../src/kubectl.ts";
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

    test("only get, logs and exec exist", () => {
        assert.deepEqual([...VERBS], ["get", "logs", "exec"]);
    });
});

describe("running kubectl", () => {
    test("starts kubectl by name with exactly those arguments, the limits of the call, and no shell", async () => {
        r.kubectl.answer({ pods: { stdout: "ok" } });
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
        assert.deepEqual(r.kubectl.calls().map((call) => call.argv), [started?.args]);
    });

    test("tells kubectl where the kubeconfig is, when Pi was told, and passes nothing else of its own environment on", async () => {
        r.kubectl.answer({ pods: { stdout: "ok" } });
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
        assert.deepEqual(r.kubectl.calls().map((call) => call.kubeconfig), ["/tmp/some/kubeconfig", undefined]);
        assert.deepEqual(r.jig.started.map((started) => started.options.env), [{ KUBECONFIG: "/tmp/some/kubeconfig" }, {}]);
    });

    test("refuses a verb that is not on the list before anything starts", async () => {
        for (const verb of ["delete", "scale", "apply", "edit", "rollout", "port-forward", "cp", "patch", "replace", "create", "run", "attach", "label", "annotate", "drain", "cordon", "taint", "auth", "config", "proxy", "debug", "set", "expose", "autoscale"]) {
            await assert.rejects(runKubectl(r.kube(), verb as Verb, [], READ), (error: Error) => {
                assert.equal(error.message, `kubectl ${verb} is not allowed: this tool only reads`);
                return true;
            });
        }
        assert.equal(r.jig.started.length, 0);
    });

    test("a command that runs out of time is an error that says how long it had", async () => {
        r.kubectl.answer({ pods: { stdout: "late", delayMs: 3000 } });
        await assert.rejects(
            runKubectl(r.kube(), "get", ["pods"], { ...READ, timeoutMs: 150 }),
            /^Error: kubectl get timed out after 0\.15 s: the cluster is slow or unreachable$/,
        );
    });

    test("a stopped call stops kubectl", async () => {
        r.kubectl.answer({ pods: { stdout: "late", delayMs: 3000 } });
        const controller = new AbortController();
        const running = runKubectl(r.kube(r.target(), controller.signal), "get", ["pods"], READ);
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(running, /kubectl was aborted/);
    });

    test("output beyond the limit is cut, and the cut can be told", async () => {
        r.kubectl.answer({ logs: { stdout: "start\n", extraBytes: 5000 } });
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
        r.kubectl.answer({ logs: { stdout: "line one\nline two\n" } });
        assert.equal(await readKubectl(r.kube(), "logs", ["orders-api-0"], LOGS), "line one\nline two\n");
    });

    test("a command that failed is one line that says what to do", async () => {
        r.kubectl.answer({ logs: { code: 1, stderr: "Error from server (Forbidden): pods is forbidden: User cannot get resource\n" } });
        await assert.rejects(
            readKubectl(r.kube(), "logs", ["orders-api-0"], LOGS),
            /^Error: The kubeconfig user is not allowed to read orders-api in staging \(Error from server \(Forbidden\)/,
        );
    });

    test("getJson asks for JSON and parses it", async () => {
        r.kubectl.answer({ pods: { stdout: { items: [{ metadata: { name: "a" } }] } } });
        assert.deepEqual(await getJson(r.kube(), "pods", ["--selector=app=orders-api"]), { items: [{ metadata: { name: "a" } }] });
        assert.deepEqual(r.kubectl.calls()[0]?.argv.slice(3), ["get", "pods", "--selector=app=orders-api", "-o", "json"]);
    });

    test("getJson says when the output is not JSON, and when it was too big to be", async () => {
        r.kubectl.answer({ pods: { stdout: "<html>nope</html>" } });
        await assert.rejects(getJson(r.kube(), "pods"), /^Error: kubectl returned output that is not JSON: report it to the user$/);
        r.jig.script = () => ({ code: 0, stdout: `{"items": [${cutMark(READ.maxBytes)}`, stderr: "", timedOut: false });
        await assert.rejects(getJson(r.kube(), "pods"), /^Error: kubectl's answer is larger than 8 MiB: the selector matches too much$/);
    });

    test("a kubectl that is not installed is reported as it is", async () => {
        r.jig.script = () => new Error("kubectl is not installed or not on PATH");
        await assert.rejects(getJson(r.kube(), "pods"), /^Error: kubectl is not installed or not on PATH$/);
    });
});
