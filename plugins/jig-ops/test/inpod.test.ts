// The health check inside a pod: a GET from one of the service's Ready pods, test environments only. What runs in the pod,
// what comes back, where the check is refused, and what goes wrong.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { curlArgs } from "../src/runtime/kubernetes/inpod.ts";
import { list, pod } from "./support/fixtures.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { section, withEntry, withEnvironment } from "./support/section.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

/** orders-api in staging has no health address, only a health check inside a pod. */
const HEALTH = { action: "health", service: "orders-api", environment: "staging" };
/** What curl prints with the tool's `-w` format. */
const curlOut = (body: string, status: number) => `${body}\n__status:${status}`;
/** What every call starts with: for a read, and for the `exec` that runs curl, which is given a few seconds more. */
const READ_PREFIX = ["--request-timeout=25s", "--context=test-cluster", "--namespace=orders-staging"];
const PREFIX = ["--request-timeout=30s", "--context=test-cluster", "--namespace=orders-staging"];
const CURL = ["curl", "-sS", "-m", "20", "-X", "GET", "-w", "\\n__status:%{http_code}"];

const execs = () => h.cluster.calls().filter((call) => call.argv[3] === "exec");
const check = (more: Record<string, unknown> = {}, options = {}) => h.runtime.call({ ...HEALTH, ...more }, options);

describe("a GET in a pod", () => {
    test("lists the pods, then runs curl in the first ready pod's own container, on the configured port and path", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0", { ready: false }), pod("orders-api-1", { sidecar: "1.20" })), exec: { stdout: curlOut('{"status":"UP"}', 200) } });
        const result = await check();
        assert.equal(ok(result), 'GET /actuator/health on orders-api-1:8080 -> HTTP 200\n{"status":"UP"}');
        assert.deepEqual(h.cluster.calls().map((call) => call.argv), [
            [...READ_PREFIX, "get", "pods", "--selector=app=orders-api", "-o", "json"],
            [...PREFIX, "exec", "orders-api-1", "-c", "orders-api", "--", ...CURL, "http://localhost:8080/actuator/health"],
        ]);
        assert.deepEqual(h.jig.facts.get(result.id), [{ status: 200 }]);
        assert.deepEqual(result.details, { pod: "orders-api-1", status: 200, bytes: 15 });
    });

    test("keeps the query of the health path", async () => {
        h.configure(withEntry("orders-api", "staging", { healthPath: "/actuator/health?full=1&x=2" }));
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        assert.match(ok(await check()), /^GET \/actuator\/health\?full=1&x=2 on orders-api-0:8080 -> HTTP 200/);
        assert.equal(execs()[0]?.argv.at(-1), "http://localhost:8080/actuator/health?full=1&x=2");
    });

    test("gives the call its limits: curl's 20 seconds, 35 for the process, and a reply of at most 2 MiB", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        const controller = new AbortController();
        ok(await check({}, { signal: controller.signal }));
        const exec = h.jig.started.find((started) => started.args[3] === "exec");
        assert.equal(exec?.options.timeoutMs, 35_000);
        assert.equal(exec?.options.maxOutputBytes, 2 * 1024 * 1024);
        assert.equal(exec?.options.signal, controller.signal);
        assert.equal(exec?.args[0], "--request-timeout=30s");
    });

    test("never reads the pod's standard input, and writes nothing to it", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        ok(await check());
        assert.equal(execs()[0]?.stdin, "");
        assert.ok(h.jig.started.every((started) => started.options.input === undefined));
        for (const arg of execs()[0]?.argv ?? []) assert.ok(arg !== "-i" && arg !== "-t" && arg !== "--stdin" && arg !== "--tty", arg);
    });

    test("a status that is not 2xx is a result, with its body", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut('{"status":"DOWN"}', 503) } });
        assert.equal(ok(await check()), 'GET /actuator/health on orders-api-0:8080 -> HTTP 503\n{"status":"DOWN"}');
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("", 404) } });
        assert.equal(ok(await check()), "GET /actuator/health on orders-api-0:8080 -> HTTP 404\n(empty body)");
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("boom", 500) } });
        assert.match(ok(await check()), /-> HTTP 500\nboom$/);
    });

    test("a body that looks like the status line does not fool the reader: the last one is curl's", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("x\n__status:500\ny", 200) } });
        const result = await check();
        assert.equal(ok(result), "GET /actuator/health on orders-api-0:8080 -> HTTP 200\nx\n__status:500\ny");
        assert.deepEqual(h.jig.facts.get(result.id), [{ status: 200 }]);
    });

    test("terminal sequences and control characters in the body do not get through", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("\u001b[31mred\u001b[0m\u0000end", 200) } });
        assert.equal(ok(await check()).split("\n")[1], "red?end");
    });

    test("a reply longer than 2 MiB is cut and says so, and no status is looked for in what is left", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: "first\n__status:200\nmore\n", extraBytes: 3 * 1024 * 1024 } });
        const result = await check();
        const text = ok(result);
        assert.match(text.split("\n")[0] ?? "", /^GET \/actuator\/health on orders-api-0:8080 -> the reply is larger than 2 MiB and was cut; its HTTP status was not read$/);
        assert.ok(!text.includes("[output cut at"));
        assert.ok(text.includes("first\n__status:200\nmore"), "the part that came is shown");
        assert.deepEqual(h.jig.facts.get(result.id), [{ cut: true }]);
    });
});

describe("what the model controls", () => {
    test("nothing: every argument of kubectl and of curl comes from the catalog", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        for (let n = 0; n < 3; n++) ok(await check());
        const argvs = execs().map((call) => call.argv);
        assert.equal(argvs.length, 3);
        for (const argv of argvs) {
            assert.deepEqual(argv.slice(0, 3), PREFIX);
            assert.deepEqual(argv.slice(3, 8), ["exec", "orders-api-0", "-c", "orders-api", "--"]);
            assert.deepEqual(argv.slice(8, -1), CURL);
            assert.equal(argv.length, 17, "one argument for the address and none besides");
            assert.equal(argv[16], "http://localhost:8080/actuator/health");
        }
    });

    test("an address that starts with // is still a path on this host", async () => {
        h.configure(withEntry("orders-api", "staging", { healthPath: "//other.test/x" }));
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        ok(await check());
        const url = execs()[0]?.argv.at(-1) ?? "";
        assert.equal(new URL(url).hostname, "localhost");
        assert.equal(new URL(url).port, "8080");
    });

    test("curl gets no flag that sends data, reads a file, follows a redirect or writes one", () => {
        const flags = curlArgs("http://localhost:8080/x").filter((arg) => arg.startsWith("-"));
        assert.deepEqual(flags, ["-sS", "-m", "-X", "-w"]);
        for (const forbidden of ["-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "-F", "--form", "-T", "--upload-file", "--json", "-L", "--location", "-o", "-O", "-K", "--config", "-H", "--header", "-u", "--user", "-b", "--cookie", "-x", "--proxy"]) {
            assert.ok(!curlArgs("http://localhost:8080/x").includes(forbidden), forbidden);
        }
        assert.equal(curlArgs("http://localhost:8080/x")[curlArgs("http://localhost:8080/x").indexOf("-X") + 1], "GET");
    });

    test("a call cannot carry a path, a body, a method, a header or a timeout: it is refused before kubectl is asked anything", async () => {
        const canary = "BODY-CANARY-91ac7";
        for (const extra of [{ path: "/x" }, { body: { note: canary } }, { data: canary }, { method: "POST" }, { headers: { "X-Canary": canary } }, { timeoutSec: 5 }, { stdin: canary }]) {
            const result = await check(extra);
            assert.match(result.blocked ?? "", /^Blocked by jig-core: runtime cannot run with this input: runtime health does not use /);
        }
        assert.deepEqual(h.cluster.calls(), []);
        assert.deepEqual(h.jig.started, []);
    });

    test("what comes back in the reply is never put into a command line", async () => {
        const canary = "REPLY-CANARY-77ab";
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut(`{"note":"${canary}"}`, 200) } });
        assert.match(ok(await check()), new RegExp(canary));
        await check();
        assert.ok(h.cluster.calls().every((call) => !JSON.stringify(call.argv).includes(canary)));
    });
});

describe("where it is refused", () => {
    /** orders-api in production, with its address taken away: only the check in a pod is left. */
    const podOnlyInProduction = () => {
        const raw = withEnvironment("orders-api", "production", { health: undefined });
        const runtime = (((raw.services as Record<string, { environments: Record<string, Record<string, unknown>> }>)["orders-api"] as { environments: Record<string, Record<string, unknown>> }).environments.production as { runtime: { kubernetes: Record<string, unknown> } }).runtime;
        Object.assign(runtime.kubernetes, { container: "orders-api", port: 8080, healthPath: "/actuator/health" });
        return raw;
    };
    const PRODUCTION = { action: "health", service: "orders-api", environment: "production" };
    const message =
        'runtime health is refused in production (orders-api in production): without a health address it would run curl inside a pod, and nothing is run in a production pod. Add "health" (an https address) to its entry in the ops catalog';

    test("in production: blocked in classify by the kind of the environment, and nothing is asked of the cluster", async () => {
        h.configure(podOnlyInProduction());
        const result = await h.runtime.call(PRODUCTION);
        assert.equal(result.blocked, `Blocked by jig-core: runtime cannot run with this input: ${message}`);
        assert.equal(result.error, undefined, "the tool did not run");
        assert.deepEqual(h.cluster.calls(), []);
        assert.deepEqual(h.jig.started, []);
    });

    test("in any environment jig-core counts as production, whatever it is called", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        h.jig.setKinds({ staging: "production" });
        const result = await check();
        assert.equal(result.blocked, "Blocked by jig-core: runtime cannot run with this input: runtime health is refused in production (orders-api in staging): without a health address it would run curl inside a pod, and nothing is run in a production pod. Add \"health\" (an https address) to its entry in the ops catalog");
        assert.deepEqual(h.cluster.calls(), []);
    });

    test("in a name jig-core has never heard of, which counts as production", async () => {
        const raw = section();
        const services = raw.services as Record<string, { environments: Record<string, unknown> }>;
        const orders = services["orders-api"] as { environments: Record<string, unknown> };
        orders.environments.edge = orders.environments.staging;
        h.configure(raw);
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        const result = await h.runtime.call({ action: "health", service: "orders-api", environment: "edge" });
        assert.match(result.blocked ?? "", /^Blocked by jig-core: runtime cannot run with this input: runtime health is refused in production \(orders-api in edge\)/);
        assert.deepEqual(h.jig.started, []);
    });

    test("when the tool is run without jig-core's check, it refuses the same way and starts nothing", async () => {
        h.configure(podOnlyInProduction());
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        await assert.rejects(
            h.runtime.tool.execute("direct", PRODUCTION as never, undefined, undefined, {} as never),
            (error: unknown) => error instanceof TypeError && error.message === message,
        );
        assert.deepEqual(h.jig.started, []);
    });

    test("where jig-core says it is not production, it runs: a test environment, or this machine", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        for (const kind of ["test", "local", "external"] as const) {
            h.jig.setKinds({ staging: kind });
            assert.match(ok(await check()), /-> HTTP 200/, kind);
        }
    });

    test("production with an address is checked by the address, and a pod is never asked", async () => {
        const asked: string[] = [];
        const local = setupHarness({ fetch: async (address) => (asked.push(String(address)), new Response("UP", { status: 200 })) });
        try {
            const result = await local.runtime.call(PRODUCTION);
            assert.equal(ok(result), "GET https://api.example.com/orders/health -> HTTP 200\nUP");
            assert.deepEqual(asked, ["https://api.example.com/orders/health"]);
            assert.deepEqual(local.cluster.calls(), []);
        } finally {
            local.close();
        }
    });

    test("the other actions still read production", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), logs: { stdout: "x\n" } });
        const result = await h.runtime.call({ action: "logs", service: "orders-api", environment: "production" });
        assert.match(ok(result), /^orders-api-0 \(container orders-api\): 1 line/);
    });
});

describe("what goes wrong in the pod", () => {
    test("no ready pod says to run pods", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0", { ready: false }), pod("orders-api-1", { deleting: true })) });
        assert.equal((await check()).error?.message, "orders-api has no ready pod in staging to call: run pods, and try again when one is ready");
        assert.deepEqual(execs(), [], "nothing was run in a pod");
    });

    test("a pod without the configured container says which setting to fix", async () => {
        const raw = pod("orders-api-0") as { spec: { containers: Array<{ name: string; image: string }> } };
        raw.spec.containers[0] = { name: "app", image: "registry.example.test/shop/app:1" };
        h.cluster.answer({ pods: list(raw) });
        assert.equal((await check()).error?.message, 'orders-api-0 has no container orders-api (it has app): fix "container" in the ops catalog of jig.json (runtime.kubernetes)');
        assert.deepEqual(execs(), []);
    });

    test("nothing listening on the port", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { code: 7, stderr: "curl: (7) Failed to connect to localhost port 8080: Connection refused\ncommand terminated with exit code 7" } });
        assert.equal(
            (await check()).error?.message,
            "nothing accepted the connection on localhost:8080 inside orders-api-0: the service may be starting, or listen on another port",
        );
    });

    test("a request that times out inside the pod", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { code: 28, stderr: "curl: (28) Operation timed out after 20001 milliseconds\ncommand terminated with exit code 28" } });
        assert.equal((await check()).error?.message, "the request timed out after 20 s inside orders-api-0");
    });

    test("a connection that closes before the answer is whole", async () => {
        for (const exit of [18, 52, 55, 56]) {
            h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { code: exit, stderr: `curl: (${exit}) Empty reply from server\ncommand terminated with exit code ${exit}` } });
            assert.equal((await check()).error?.message, "the connection inside orders-api-0 closed before the answer was complete", String(exit));
        }
    });

    test("any other curl failure, with curl's own words", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { code: 3, stderr: "curl: (3) URL using bad/illegal format or missing URL\ncommand terminated with exit code 3" } });
        assert.match((await check()).error?.message ?? "", /^curl failed inside orders-api-0 \(exit 3\): curl: \(3\) URL using bad\/illegal format or missing URL; command terminated with exit code 3$/);
    });

    test("a container without curl says the pod needs it", async () => {
        h.cluster.answer({
            pods: list(pod("orders-api-0")),
            exec: { code: 126, stderr: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "curl": executable file not found in $PATH: unknown\ncommand terminated with exit code 126' },
        });
        assert.equal((await check()).error?.message, "orders-api-0 has no curl in container orders-api: the health check inside a pod needs curl");
    });

    test("kubectl's own failures read as they do for the other actions", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { code: 1, stderr: "Unable to connect to the server: dial tcp: i/o timeout" } });
        assert.match((await check()).error?.message ?? "", /^Cannot reach the cluster of context test-cluster for orders-api in staging/);
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { code: 1, stderr: 'Error from server (Forbidden): pods "orders-api-0" is forbidden: User "u" cannot create resource "pods/exec"' } });
        assert.match((await check()).error?.message ?? "", /^The kubeconfig user is not allowed to read orders-api in staging/);
    });

    test("a reply with no status is reported, not guessed", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: "no status here" } });
        assert.equal((await check()).error?.message, "The reply from orders-api-0 had no HTTP status: report it to the user");
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: "x\n__status:abc" } });
        assert.match((await check()).error?.message ?? "", /had no HTTP status/);
        h.cluster.answer({ pods: list(pod("orders-api-0")), exec: { stdout: "x\n__status:000" } });
        assert.match((await check()).error?.message ?? "", /had no HTTP status/);
    });

    test("a command that runs out of time is an error that names the limit", async () => {
        h.cluster.answer({ pods: list(pod("orders-api-0")) });
        h.jig.script = (_file, args) => (args[3] === "exec" ? { code: 124, stdout: "", stderr: "", timedOut: true } : undefined);
        assert.equal((await check()).error?.message, "kubectl exec timed out after 35 s: the cluster is slow or unreachable");
    });
});
