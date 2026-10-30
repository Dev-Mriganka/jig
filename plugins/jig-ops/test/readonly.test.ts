// The runtime tool only reads, and only where the catalog says. Every kubectl command line of every call is checked against the
// few shapes the plugin can build (see support/argv.ts): a verb that writes, a flag that points kubectl elsewhere, a context or
// a namespace the model chose, would each show up as a problem. The model cannot cause any of them, whatever it sends, and
// these tests send a lot. The deploy tool, the only one that writes, has its own checks in deploy-guard.test.ts.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { problems } from "./support/argv.ts";
import { list, pod, workload } from "./support/fixtures.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { withEntry } from "./support/section.ts";
import { codeOf, sources as readSources } from "./support/sources.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

/** Every verb of kubectl that changes something, or opens a way in, or leaves the cluster's API. */
const WRITING_VERBS = [
    "delete", "scale", "apply", "edit", "patch", "replace", "create", "run", "expose", "set", "autoscale", "rollout", "restart",
    "port-forward", "cp", "attach", "label", "annotate", "taint", "cordon", "uncordon", "drain", "certificate", "auth", "config",
    "proxy", "debug", "diff", "kustomize", "wait", "describe", "top", "events", "explain", "api-resources", "plugin", "completion",
];

/** The ones of those that are also the name of an action of the runtime tool, which reads. */
const OUR_ACTIONS = ["rollout", "events"];

/** Where each service in the default catalog runs. */
const TARGETS = [
    { service: "orders-api", environment: "staging", context: "test-cluster", namespace: "orders-staging", selector: "app=orders-api" },
    { service: "orders-api", environment: "production", context: "prod-cluster", namespace: "orders", selector: "app=orders-api,tier=web" },
    { service: "billing", environment: "staging", context: "test-cluster", namespace: "billing-staging", selector: "app=billing" },
];
const STAGING = TARGETS[0] as (typeof TARGETS)[number];

/** A cluster that has something to answer for every kind of call. */
function populate(service: string): void {
    h.cluster.answer({
        pods: list(pod(`${service}-0`, { service, sidecar: "1.20", initContainer: "migrate" }), pod(`${service}-1`, { service })),
        workloads: list(workload(service, { service })),
        replicasets: list(),
        events: list(),
        logs: { stdout: "a line\n" },
        exec: { stdout: "{}\n__status:200" },
    });
}

/** The calls kubectl got since `from`. */
const since = (from: number) => h.cluster.calls().slice(from);

describe("every call that can be made", () => {
    test("is a get, a logs or an exec, in the context and namespace of the catalog, with an argument list of a known shape", async () => {
        let total = 0;
        for (const target of TARGETS) {
            populate(target.service);
            const inputs: Array<Record<string, unknown>> = [
                { action: "pods" },
                { action: "rollout" },
                { action: "rollout", waitFor: "1.4.3", timeoutSec: 1 },
                { action: "logs" },
                { action: "logs", pod: `${target.service}-1`, tail: 2000, sinceSeconds: 86_400, previous: true },
                { action: "logs", pod: `${target.service}-0`, container: "migrate", tail: 1 },
                { action: "logs", container: "mesh-proxy" },
                { action: "events" },
                // Only orders-api in staging has no address and checks inside a pod.
                ...(target.service === "orders-api" && target.environment === "staging" ? [{ action: "health" }] : []),
            ];
            for (const input of inputs) {
                const before = h.cluster.calls().length;
                const result = await h.runtime.call({ service: target.service, environment: target.environment, ...input });
                assert.equal(result.blocked, undefined, JSON.stringify(input));
                const made = since(before);
                assert.ok(made.length > 0, `${JSON.stringify(input)} made no kubectl call`);
                for (const call of made) assert.deepEqual(problems(call.argv, target), [], `${target.service} ${target.environment} ${JSON.stringify(input)}: ${call.argv.join(" ")}`);
                total += made.length;
            }
        }
        assert.ok(total >= 50, `${total} calls were checked`);
    });

    test("is started as kubectl, by name, with an argument list, and no input", async () => {
        populate("orders-api");
        await h.runtime.call({ action: "pods", service: "orders-api", environment: "staging" });
        await h.runtime.call({ action: "logs", service: "orders-api", environment: "staging" });
        assert.ok(h.jig.started.length >= 3);
        for (const started of h.jig.started) {
            assert.equal(started.file, "kubectl");
            assert.ok(Array.isArray(started.args) && started.args.every((arg) => typeof arg === "string"));
            assert.equal(started.options.input, undefined);
        }
    });

    test("never starts helm", async () => {
        populate("orders-api");
        for (const action of ["pods", "rollout", "logs", "events", "health"]) await h.runtime.call({ action, service: "orders-api", environment: "staging" });
        assert.deepEqual(h.cluster.helmCalls(), []);
        assert.ok(h.jig.started.every((started) => started.file === "kubectl"));
    });
});

describe("what the model sends", () => {
    /** Values that would be a flag, a verb, a second command or another place, in every parameter that takes text. */
    const hostile = [
        "delete", "-A", "--all-namespaces", "--all", "--context=other", "--namespace=kube-system", "-n", "--token=abc", "--server=https://x.test",
        "--kubeconfig=/tmp/x", "--as=admin", "--as-group=system:masters", "--insecure-skip-tls-verify", "x; delete pod x", "x && delete pod x", "$(id)", "`id`",
        "../../etc/passwd", "a b", "a\nb", "a\u0000b", "", "pods,secrets", "*", "orders-api --context=other", "staging --namespace=kube-system",
    ];

    test("never changes the verb, the context, the namespace or the shape, in any parameter", async () => {
        populate("orders-api");
        // Each action gets a hostile value in every parameter it takes, one at a time, and a fine value in the others.
        const takes: Record<string, string[]> = { pods: [], rollout: ["waitFor"], logs: ["pod", "container"], events: [], health: [] };
        let blocked = 0;
        let ran = 0;
        for (const [action, names] of Object.entries(takes)) {
            for (const name of ["service", "environment", ...names]) {
                for (const value of hostile) {
                    const before = h.cluster.calls().length;
                    const input = { action, service: "orders-api", environment: "staging", [name]: value };
                    const result = await h.runtime.call(input);
                    if (result.blocked !== undefined) blocked++;
                    else ran++;
                    for (const call of since(before)) {
                        assert.deepEqual(problems(call.argv, STAGING), [], `${action} ${name}=${JSON.stringify(value)}: ${call.argv.join(" ")}`);
                    }
                }
            }
        }
        assert.ok(blocked > 200, `${blocked} calls were blocked`);
        assert.ok(ran >= 3, `${ran} calls ran: a value that is a legal name reaches kubectl, and still changes nothing`);
    });

    test("cannot name a verb, a flag, an argument list, a command, an address or a path", async () => {
        populate("orders-api");
        const before = h.cluster.calls().length;
        const base = { action: "pods", service: "orders-api", environment: "staging" };
        for (const extra of [
            { verb: "delete" }, { command: "delete pod x" }, { args: ["delete", "pod", "x"] }, { argv: ["delete"] }, { flags: ["--all"] },
            { subcommand: "scale" }, { resource: "secrets" }, { kind: "secret" }, { output: "yaml" }, { selector: "app=other" }, { labels: "app=other" },
            { context: "other" }, { namespace: "kube-system" }, { cluster: "other" }, { kubeconfig: "/tmp/x" }, { allNamespaces: true }, { env: { A: "b" } },
            { stdin: "x" }, { shell: "sh -c id" }, { exec: "id" }, { cmd: "id" }, { url: "https://other.test/" }, { path: "/x" }, { port: 1 },
        ]) {
            const result = await h.runtime.call({ ...base, ...extra });
            assert.match(result.blocked ?? "", /^Blocked by jig-core: runtime cannot run with this input: runtime pods does not use /, JSON.stringify(extra));
        }
        assert.equal(since(before).length, 0);
    });

    test("cannot name an action that writes", async () => {
        for (const action of WRITING_VERBS.filter((verb) => !OUR_ACTIONS.includes(verb))) {
            const result = await h.runtime.call({ action, service: "orders-api", environment: "staging" });
            assert.match(result.blocked ?? "", /^Blocked by jig-core: runtime cannot run with this input: runtime: action must be one of pods, rollout, logs, events, health/, action);
        }
        assert.deepEqual(h.cluster.calls(), []);
        assert.deepEqual(h.cluster.helmCalls(), []);
    });

    test("cannot reach a pod of another service, whatever the pod is called", async () => {
        populate("orders-api");
        const before = h.cluster.calls().length;
        for (const pod of ["billing-0", "kube-apiserver-node-1", "delete", "orders-api-9", "orders-api-0.", "ORDERS-API-0"]) {
            const result = await h.runtime.call({ action: "logs", service: "orders-api", environment: "staging", pod });
            assert.ok(result.error !== undefined || result.blocked !== undefined, pod);
        }
        for (const call of since(before)) assert.equal(call.argv[3], "get", "only the service's own pods were listed; no log was asked for");
    });
});

describe("what the cluster sends", () => {
    test("a pod called after a verb is a pod, and the verb stays the verb", async () => {
        for (const name of WRITING_VERBS.filter((verb) => /^[a-z0-9-]+$/.test(verb) && !verb.startsWith("-") && !verb.endsWith("-"))) {
            h.cluster.answer({ pods: list(pod(name, { service: "orders-api" })), logs: { stdout: "x\n" }, exec: { stdout: "{}\n__status:200" } });
            const before = h.cluster.calls().length;
            const logs = await h.runtime.call({ action: "logs", service: "orders-api", environment: "staging" });
            const named = await h.runtime.call({ action: "logs", service: "orders-api", environment: "staging", pod: name });
            const health = await h.runtime.call({ action: "health", service: "orders-api", environment: "staging" });
            assert.equal(logs.error, undefined, name);
            assert.equal(named.error, undefined, name);
            assert.equal(health.error, undefined, name);
            const made = since(before);
            assert.ok(made.some((call) => call.argv[3] === "logs" && call.argv[4] === name), name);
            for (const call of made) assert.deepEqual(problems(call.argv, STAGING), [], `${name}: ${call.argv.join(" ")}`);
            assert.ok(made.every((call) => ["get", "logs", "exec"].includes(call.argv[3] ?? "")), name);
        }
    });

    test("a pod or a container whose name could be read as a flag is not used", async () => {
        const flagLike = pod("-A", { service: "orders-api" });
        const fine = pod("orders-api-0", { service: "orders-api" }) as { spec: { containers: Array<{ name: string; image: string }> } };
        fine.spec.containers.push({ name: "--all-containers", image: "registry.example.test/x:1" });
        h.cluster.answer({ pods: list(flagLike, fine), logs: { stdout: "x\n" } });
        const pods = await h.runtime.call({ action: "pods", service: "orders-api", environment: "staging" });
        assert.match(pods.text, /^1 pod of /, "the flag-like pod is not a pod");
        assert.match(pods.text, /- orders-api-0: 1\/1 ready/, "and the flag-like container is not one of the pod's containers");
        await h.runtime.call({ action: "logs", service: "orders-api", environment: "staging" });
        const logs = h.cluster.calls().find((call) => call.argv[3] === "logs");
        assert.deepEqual(logs?.argv.slice(3), ["logs", "orders-api-0", "-c", "orders-api", "--tail=200"]);
        for (const call of h.cluster.calls()) assert.deepEqual(problems(call.argv, STAGING), []);
    });
});

describe("where the context and the namespace come from", () => {
    test("the catalog, for every service, as it is written there", async () => {
        h.configure(withEntry("billing", "staging", {
            context: "arn:aws:eks:eu-west-1:123456789012:cluster/test",
            namespace: "billing-9",
            selector: "app.kubernetes.io/name=billing",
        }));
        populate("billing");
        await h.runtime.call({ action: "pods", service: "billing", environment: "staging" });
        assert.deepEqual(h.cluster.calls()[0]?.argv.slice(0, 4), [
            "--request-timeout=25s",
            "--context=arn:aws:eks:eu-west-1:123456789012:cluster/test",
            "--namespace=billing-9",
            "get",
        ]);
        assert.equal(h.cluster.calls()[0]?.argv[5], "--selector=app.kubernetes.io/name=billing");
    });

    test("the catalog of the moment: a change applies to the next call", async () => {
        populate("orders-api");
        await h.runtime.call({ action: "pods", service: "orders-api", environment: "staging" });
        h.configure(withEntry("orders-api", "staging", { context: "moved-cluster", namespace: "moved" }));
        await h.runtime.call({ action: "pods", service: "orders-api", environment: "staging" });
        assert.deepEqual(h.cluster.calls().map((call) => call.argv.slice(1, 3)), [
            ["--context=test-cluster", "--namespace=orders-staging"],
            ["--context=moved-cluster", "--namespace=moved"],
        ]);
    });

    test("a service the catalog lacks is never looked for", async () => {
        const result = await h.runtime.call({ action: "pods", service: "kube-system", environment: "staging" });
        assert.match(result.blocked ?? "", /no service named "kube-system"/);
        assert.deepEqual(h.cluster.calls(), []);
    });
});

describe("the code", () => {
    const sources = readSources();
    const files = (pattern: RegExp) => sources.filter(({ text }) => pattern.test(codeOf(text))).map(({ file }) => file);

    test("starts kubectl in one file only, and builds its argument list in that file only", () => {
        assert.ok(files(/\.exec\.run\(/).includes("runtime/kubernetes/kubectl.ts"));
        const building = files(/--request-timeout|--context=|--namespace=/);
        assert.deepEqual(building, ["runtime/kubernetes/kubectl.ts"]);
        const kubectl = sources.filter(({ text }) => /exec\.run\(\s*"kubectl"/.test(codeOf(text))).map(({ file }) => file);
        assert.deepEqual(kubectl, ["runtime/kubernetes/kubectl.ts"]);
    });

    test("starts programs through jig-core's exec.run and never by itself", () => {
        for (const { file, text } of sources) {
            assert.ok(!/node:child_process|\bspawn\b|\bexecFile|\bexecSync\b|\bshell\s*:/.test(codeOf(text)), `${file} starts a process by itself`);
        }
    });

    test("names no verb that writes, in any string, outside the places that build the two writes", () => {
        const verbs = WRITING_VERBS.filter((verb) => !["config", "wait", "set", "run", "events", "top", "describe", "plugin", "auth", "diff", "explain", "restart", "rollout"].includes(verb));
        for (const { file, text } of sources) {
            for (const verb of verbs) {
                assert.ok(!new RegExp(`["'\`]${verb}["'\`]`).test(codeOf(text)), `${file} has the string "${verb}"`);
            }
        }
    });

    test("the word rollout is an action of the runtime tool, and the verb of kubectl rollout undo, and nothing else", () => {
        // `set` is the other verb of a write; it is common English and a Set, so the files that build it are named instead.
        assert.deepEqual(files(/["'`]rollout["'`]/), [
            "deploy/command.ts",
            "deploy/kubectl-image.ts",
            "runtime/kubernetes/kubectl.ts",
            "runtime/params.ts",
            "runtime/tool.ts",
        ]);
        assert.deepEqual(files(/verb: "set"|then: "image"/), ["deploy/command.ts", "deploy/kubectl-image.ts", "runtime/kubernetes/kubectl.ts"]);
    });

    test("lists the commands kubectl may run, and the runner asks the list", () => {
        const text = sources.find((source) => source.file === "runtime/kubernetes/kubectl.ts")?.text ?? "";
        assert.match(codeOf(text), /export const READS = \["get", "logs", "exec"\] as const;/);
        assert.match(codeOf(text), /\{ verb: "set", then: "image" \},\s*\{ verb: "rollout", then: "undo" \},/);
        assert.match(codeOf(text), /if \(!allowed\(verb, args\)\) \{\s*const what[^]*throw/);
    });
});
