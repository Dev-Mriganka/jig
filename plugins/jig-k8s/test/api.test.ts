// The api action: a GET from inside a ready pod, test environments only. What runs in the pod, what comes back, where the
// action is refused, and what goes wrong.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { curlArgs } from "../src/api.ts";
import { createDecisions, DECISION_EVENT, requireNotProduction } from "../src/decisions.ts";
import { list, pod } from "./support/fixtures.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { rig } from "./support/rig.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

const API = { action: "api", service: "orders-api", environment: "staging" };
/** What curl prints with the tool's `-w` format. */
const curlOut = (body: string, status: number) => `${body}\n__status:${status}`;
/** What every call starts with: for a read, and for the `exec` that runs curl, which is given a few seconds more. */
const READ_PREFIX = ["--request-timeout=25s", "--context=test-cluster", "--namespace=orders-staging"];
const PREFIX = ["--request-timeout=30s", "--context=test-cluster", "--namespace=orders-staging"];
const CURL = ["curl", "-sS", "-m", "20", "-X", "GET", "-w", "\\n__status:%{http_code}"];

const execs = () => h.kubectl.calls().filter((call) => call.argv[3] === "exec");

describe("a GET in a pod", () => {
    test("lists the pods, then runs curl in the first ready pod's own container, on the configured port", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0", { ready: false }), pod("orders-api-1", { sidecar: "1.20" })), exec: { stdout: curlOut('{"status":"UP"}', 200) } });
        const result = await h.call({ ...API, path: "/actuator/health?x=1&y=2" });
        assert.equal(ok(result), 'GET /actuator/health?x=1&y=2 on orders-api-1:8080 -> HTTP 200\n{"status":"UP"}');
        assert.deepEqual(h.kubectl.calls().map((call) => call.argv), [
            [...READ_PREFIX, "get", "pods", "--selector=app=orders-api", "-o", "json"],
            [...PREFIX, "exec", "orders-api-1", "-c", "orders-api", "--", ...CURL, "http://localhost:8080/actuator/health?x=1&y=2"],
        ]);
        assert.deepEqual(h.jig.facts.get(result.id), [{ status: 200 }]);
        assert.deepEqual(result.details, { pod: "orders-api-1", status: 200, bytes: 15 });
    });

    test("gives the call its limits: curl's 20 seconds, 35 for the process, and a reply of at most 2 MiB", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        const controller = new AbortController();
        ok(await h.call({ ...API, path: "/x" }, { signal: controller.signal }));
        const exec = h.jig.started.find((started) => started.args[3] === "exec");
        assert.equal(exec?.options.timeoutMs, 35_000);
        assert.equal(exec?.options.maxOutputBytes, 2 * 1024 * 1024);
        assert.equal(exec?.options.signal, controller.signal);
        assert.equal(exec?.args[0], "--request-timeout=30s");
    });

    test("never reads the pod's standard input, and writes nothing to it", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        ok(await h.call({ ...API, path: "/x" }));
        assert.equal(execs()[0]?.stdin, "");
        assert.ok(h.jig.started.every((started) => started.options.input === undefined));
        for (const arg of execs()[0]?.argv ?? []) assert.ok(arg !== "-i" && arg !== "-t" && arg !== "--stdin" && arg !== "--tty", arg);
    });

    test("a status that is not 2xx is a result, with its body", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut('{"error":"forbidden"}', 403) } });
        assert.equal(ok(await h.call({ ...API, path: "/admin" })), 'GET /admin on orders-api-0:8080 -> HTTP 403\n{"error":"forbidden"}');
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("", 404) } });
        assert.equal(ok(await h.call({ ...API, path: "/missing" })), "GET /missing on orders-api-0:8080 -> HTTP 404\n(empty body)");
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("boom", 500) } });
        assert.match(ok(await h.call({ ...API, path: "/x" })), /-> HTTP 500\nboom$/);
    });

    test("a body that looks like the status line does not fool the reader: the last one is curl's", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("x\n__status:500\ny", 200) } });
        const result = await h.call({ ...API, path: "/x" });
        assert.equal(ok(result), "GET /x on orders-api-0:8080 -> HTTP 200\nx\n__status:500\ny");
        assert.deepEqual(h.jig.facts.get(result.id), [{ status: 200 }]);
    });

    test("terminal sequences and control characters in the body do not get through", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("\u001b[31mred\u001b[0m\u0000end", 200) } });
        assert.equal(ok(await h.call({ ...API, path: "/x" })).split("\n")[1], "red?end");
    });

    test("a reply longer than 2 MiB is cut and says so, and no status is looked for in what is left", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: "first\n__status:200\nmore\n", extraBytes: 3 * 1024 * 1024 } });
        const result = await h.call({ ...API, path: "/big" });
        const text = ok(result);
        assert.match(text.split("\n")[0] ?? "", /^GET \/big on orders-api-0:8080 -> the reply is larger than 2 MiB and was cut; its HTTP status was not read$/);
        assert.ok(!text.includes("[output cut at"));
        assert.ok(text.includes("first\n__status:200\nmore"), "the part that came is shown");
        assert.deepEqual(h.jig.facts.get(result.id), [{ cut: true }]);
    });
});

describe("what the model controls", () => {
    test("is the path and nothing else: every other argument of kubectl and of curl is fixed", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        const paths = ["/a", "/a/b?c=d", "/a;b$c'(d)*+,=:@%20!&", "/v1/a?x=$(id)&y=;rm%20-rf", "//other.test/x", "/"];
        for (const path of paths) ok(await h.call({ ...API, path }));
        const argvs = execs().map((call) => call.argv);
        assert.equal(argvs.length, paths.length);
        for (const argv of argvs) {
            assert.deepEqual(argv.slice(0, 3), PREFIX);
            assert.deepEqual(argv.slice(3, 8), ["exec", "orders-api-0", "-c", "orders-api", "--"]);
            assert.deepEqual(argv.slice(8, -1), CURL);
            assert.equal(argv.length, 17, "one argument for the address and none besides");
        }
        assert.deepEqual(argvs.map((argv) => argv[16]), paths.map((path) => `http://localhost:8080${path}`), "the path is one argument, as it was given");
    });

    test("an address that starts with // is still a path on this host", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        ok(await h.call({ ...API, path: "//other.test/x" }));
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

    test("a call cannot carry a body, a method, a header or a timeout: it is refused before kubectl is asked anything", async () => {
        const canary = "BODY-CANARY-91ac7";
        for (const extra of [{ body: { note: canary } }, { data: canary }, { method: "POST" }, { headers: { "X-Canary": canary } }, { timeoutSec: 5 }, { stdin: canary }]) {
            const result = await h.call({ ...API, path: "/x", ...extra });
            assert.match(result.blocked ?? "", /^Blocked by jig-core: k8s cannot run with this input: k8s api does not use /);
        }
        assert.deepEqual(h.kubectl.calls(), []);
        assert.deepEqual(h.jig.started, []);
    });

    test("what comes back in the reply is never put into a command line", async () => {
        const canary = "REPLY-CANARY-77ab";
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut(`{"note":"${canary}"}`, 200) } });
        assert.match(ok(await h.call({ ...API, path: "/x" })), new RegExp(canary));
        await h.call({ ...API, path: "/y" });
        assert.ok(h.kubectl.calls().every((call) => !JSON.stringify(call.argv).includes(canary)));
    });
});

describe("where it is refused", () => {
    test("in an environment that is called production: blocked by jig-core, and nothing is asked of the cluster", async () => {
        const result = await h.call({ action: "api", service: "orders-api", environment: "production", path: "/x" });
        assert.equal(
            result.blocked,
            "Blocked by jig-core: k8s cannot run with this input: k8s api is refused in production (orders-api in production): it runs in test environments only; orders-api has it in staging",
        );
        assert.deepEqual(h.kubectl.calls(), []);
        assert.deepEqual(h.jig.started, []);
    });

    test("in any environment jig-core decides is production, whatever it is called: refused before kubectl is started", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        const result = await h.call({ ...API, path: "/x" }, { kinds: { staging: "production" } });
        assert.equal(result.error?.message, "k8s api is refused in production (orders-api in staging): it runs in test environments only. Nothing was run");
        assert.equal(result.cls?.environment, "staging", "classify could not know: only jig-core did");
        assert.deepEqual(h.kubectl.calls(), []);
        assert.deepEqual(h.jig.started, []);
    });

    test("when jig-core never said what it decided for the call: refused, because nobody vouches for the environment", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        const result = await h.call({ ...API, path: "/x" }, { silent: true });
        assert.match(result.error?.message ?? "", /^k8s api could not confirm that orders-api in staging is not production: jig-core did not say which environment it decided this call in\. Nothing was run$/);
        assert.deepEqual(h.jig.started, []);
    });

    test("when jig-core decided the call for another environment: refused", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        h.emit(DECISION_EVENT, { toolCallId: "direct", tool: "k8s", environment: "somewhere-else", environmentKind: "test" });
        await assert.rejects(
            h.tool.execute("direct", { ...API, path: "/x" } as never, undefined, undefined, {} as never),
            /^Error: k8s api could not confirm that orders-api in staging is not production/,
        );
        assert.deepEqual(h.jig.started, []);
    });

    test("a decision about another call, or by another tool, is not a decision about this one", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        h.emit(DECISION_EVENT, { toolCallId: "mine", tool: "http", environment: "staging", environmentKind: "test" });
        h.emit(DECISION_EVENT, { toolCallId: "other", tool: "k8s", environment: "staging", environmentKind: "test" });
        await assert.rejects(h.tool.execute("mine", { ...API, path: "/x" } as never, undefined, undefined, {} as never), /could not confirm/);
        assert.deepEqual(h.jig.started, []);
    });

    test("where jig-core says it is not production, it runs: a test environment, or this machine", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: curlOut("{}", 200) } });
        for (const kind of ["test", "local", "external"] as const) {
            const result = await h.call({ ...API, path: "/x" }, { kinds: { staging: kind } });
            assert.match(ok(result), /-> HTTP 200/, kind);
        }
    });

    test("where no container or port is configured: blocked, with what to add", async () => {
        const result = await h.call({ action: "api", service: "billing", environment: "staging", path: "/x" });
        assert.equal(
            result.blocked,
            'Blocked by jig-core: k8s cannot run with this input: k8s api: not set up for billing in staging: add "container" and "port" to its entry in the k8s section of jig.json',
        );
        assert.deepEqual(h.kubectl.calls(), []);
    });

    test("the other actions still read production", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), logs: { stdout: "x\n" } });
        const result = await h.call({ action: "logs", service: "orders-api", environment: "production" });
        assert.match(ok(result), /^orders-api-0 \(container orders-api\): 1 line/);
    });
});

describe("what goes wrong in the pod", () => {
    const call = () => h.call({ ...API, path: "/x" });

    test("no ready pod says to run pods", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0", { ready: false }), pod("orders-api-1", { deleting: true })) });
        assert.equal((await call()).error?.message, "orders-api has no ready pod in staging to call: run pods, and try again when one is ready");
        assert.deepEqual(execs(), [], "nothing was run in a pod");
    });

    test("a pod without the configured container says which setting to fix", async () => {
        const raw = pod("orders-api-0") as { spec: { containers: Array<{ name: string; image: string }> } };
        raw.spec.containers[0] = { name: "app", image: "registry.example.test/shop/app:1" };
        h.kubectl.answer({ pods: list(raw) });
        assert.equal((await call()).error?.message, 'orders-api-0 has no container orders-api (it has app): fix "container" in the k8s section of jig.json');
        assert.deepEqual(execs(), []);
    });

    test("nothing listening on the port", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { code: 7, stderr: "curl: (7) Failed to connect to localhost port 8080: Connection refused\ncommand terminated with exit code 7" } });
        assert.equal(
            (await call()).error?.message,
            "nothing accepted the connection on localhost:8080 inside orders-api-0: the service may be starting, or listen on another port",
        );
    });

    test("a request that times out inside the pod", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { code: 28, stderr: "curl: (28) Operation timed out after 20001 milliseconds\ncommand terminated with exit code 28" } });
        assert.equal((await call()).error?.message, "the request timed out after 20 s inside orders-api-0");
    });

    test("a connection that closes before the answer is whole", async () => {
        for (const exit of [18, 52, 55, 56]) {
            h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { code: exit, stderr: `curl: (${exit}) Empty reply from server\ncommand terminated with exit code ${exit}` } });
            assert.equal((await call()).error?.message, "the connection inside orders-api-0 closed before the answer was complete", String(exit));
        }
    });

    test("any other curl failure, with curl's own words", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { code: 3, stderr: "curl: (3) URL using bad/illegal format or missing URL\ncommand terminated with exit code 3" } });
        assert.match((await call()).error?.message ?? "", /^curl failed inside orders-api-0 \(exit 3\): curl: \(3\) URL using bad\/illegal format or missing URL; command terminated with exit code 3$/);
    });

    test("a container without curl says the pod needs it", async () => {
        h.kubectl.answer({
            pods: list(pod("orders-api-0")),
            exec: { code: 126, stderr: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "curl": executable file not found in $PATH: unknown\ncommand terminated with exit code 126' },
        });
        assert.equal((await call()).error?.message, "orders-api-0 has no curl in container orders-api: api needs curl inside the pod");
    });

    test("kubectl's own failures read as they do for the other actions", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { code: 1, stderr: "Unable to connect to the server: dial tcp: i/o timeout" } });
        assert.match((await call()).error?.message ?? "", /^Cannot reach the cluster of context test-cluster for orders-api in staging/);
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { code: 1, stderr: 'Error from server (Forbidden): pods "orders-api-0" is forbidden: User "u" cannot create resource "pods/exec"' } });
        assert.match((await call()).error?.message ?? "", /^The kubeconfig user is not allowed to read orders-api in staging/);
    });

    test("a reply with no status is reported, not guessed", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: "no status here" } });
        assert.equal((await call()).error?.message, "The reply from orders-api-0 had no HTTP status: report it to the user");
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: "x\n__status:abc" } });
        assert.match((await call()).error?.message ?? "", /had no HTTP status/);
        h.kubectl.answer({ pods: list(pod("orders-api-0")), exec: { stdout: "x\n__status:000" } });
        assert.match((await call()).error?.message ?? "", /had no HTTP status/);
    });

    test("a command that runs out of time is an error that names the limit", async () => {
        h.kubectl.answer({ pods: list(pod("orders-api-0")) });
        h.jig.script = (_file, args) => (args[3] === "exec" ? { code: 124, stdout: "", stderr: "", timedOut: true } : undefined);
        assert.equal((await call()).error?.message, "kubectl exec timed out after 35 s: the cluster is slow or unreachable");
    });
});

describe("what jig-core decided", () => {
    const event = (id: string, extra: Record<string, unknown> = {}) => ({ toolCallId: id, tool: "k8s", environment: "staging", environmentKind: "test", ...extra });

    test("is remembered per call, and the name of the event is the one jig-core publishes", async () => {
        const decisions = createDecisions();
        decisions.remember(event("a"));
        decisions.remember(event("b", { environment: "production", environmentKind: "production" }));
        assert.deepEqual(decisions.seen("a"), { environment: "staging", kind: "test" });
        assert.deepEqual(decisions.seen("b"), { environment: "production", kind: "production" });
        assert.equal(decisions.seen("c"), undefined);
        const { JIG_EVENTS } = await import("../../jig-core/src/contract.ts");
        assert.equal(DECISION_EVENT, JIG_EVENTS.decision);
    });

    test("takes no notice of anything that is not a decision about a k8s call", () => {
        const decisions = createDecisions();
        for (const message of [null, undefined, 5, "x", [], {}, event("a", { tool: "http" }), event("a", { toolCallId: 5 }), event("a", { environment: 5 }), event("a", { environmentKind: "staging" }), event("a", { environmentKind: undefined })]) {
            decisions.remember(message);
        }
        assert.equal(decisions.seen("a"), undefined);
    });

    test("a later decision for the same call replaces the earlier one", () => {
        const decisions = createDecisions();
        decisions.remember(event("a"));
        decisions.remember(event("a", { environmentKind: "production" }));
        assert.equal(decisions.seen("a")?.kind, "production");
    });

    test("keeps the latest two hundred, so a long session does not grow it without end", () => {
        const decisions = createDecisions();
        for (let n = 0; n < 250; n++) decisions.remember(event(`call-${n}`));
        assert.equal(decisions.seen("call-0"), undefined);
        assert.equal(decisions.seen("call-49"), undefined);
        assert.ok(decisions.seen("call-50"));
        assert.ok(decisions.seen("call-249"));
    });

    test("requireNotProduction passes a test environment, and refuses production and the unknown", () => {
        const r = rig();
        try {
            const decisions = createDecisions();
            const target = r.target();
            decisions.remember(event("ok"));
            decisions.remember(event("prod", { environmentKind: "production" }));
            decisions.remember(event("elsewhere", { environment: "qa" }));
            assert.doesNotThrow(() => requireNotProduction(decisions, "ok", target));
            assert.throws(() => requireNotProduction(decisions, "prod", target), /^Error: k8s api is refused in production \(orders-api in staging\)/);
            assert.throws(() => requireNotProduction(decisions, "elsewhere", target), /could not confirm/);
            assert.throws(() => requireNotProduction(decisions, "never-heard-of", target), /could not confirm/);
        } finally {
            r.close();
        }
    });
});
