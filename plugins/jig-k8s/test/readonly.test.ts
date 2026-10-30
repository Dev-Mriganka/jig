// The tool only reads, and only where the configuration says. Every kubectl command line of every call is checked against
// the few shapes the plugin can build (see support/argv.ts): a verb that writes, a flag that points kubectl elsewhere, a
// context or a namespace the model chose, would each show up as a problem. The model cannot cause any of them, whatever it
// sends, and these tests send a lot.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { problems } from "./support/argv.ts";
import { list, pod, workload } from "./support/fixtures.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { section } from "./support/section.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every verb of kubectl that changes something, or opens a way in, or leaves the cluster's API. */
const WRITING_VERBS = [
    "delete", "scale", "apply", "edit", "patch", "replace", "create", "run", "expose", "set", "autoscale", "rollout", "restart",
    "port-forward", "cp", "attach", "label", "annotate", "taint", "cordon", "uncordon", "drain", "certificate", "auth", "config",
    "proxy", "debug", "diff", "kustomize", "wait", "describe", "top", "events", "explain", "api-resources", "plugin", "completion",
];

/** Where each service in the default section runs. */
const TARGETS = [
    { service: "orders-api", environment: "staging", context: "test-cluster", namespace: "orders-staging", selector: "app=orders-api" },
    { service: "orders-api", environment: "production", context: "prod-cluster", namespace: "orders", selector: "app=orders-api,tier=web" },
    { service: "billing", environment: "staging", context: "test-cluster", namespace: "billing-staging", selector: "app=billing" },
];

/** A cluster that has something to answer for every kind of call. */
function populate(service: string): void {
    h.kubectl.answer({
        pods: list(pod(`${service}-0`, { service, sidecar: "1.20", initContainer: "migrate" }), pod(`${service}-1`, { service })),
        workloads: list(workload(service, { service })),
        logs: { stdout: "a line\n" },
        exec: { stdout: "{}\n__status:200" },
    });
}

/** The calls kubectl got since `from`. */
const since = (from: number) => h.kubectl.calls().slice(from);

describe("every call that can be made", () => {
    test("is a get, a logs or an exec, in the context and namespace of the configuration, with an argument list of a known shape", async () => {
        let total = 0;
        for (const target of TARGETS) {
            populate(target.service);
            const inputs: Array<Record<string, unknown>> = [
                { action: "pods" },
                { action: "status" },
                { action: "status", waitFor: "1.4.3", timeoutSec: 1 },
                { action: "logs" },
                { action: "logs", pod: `${target.service}-1`, tail: 2000, sinceSeconds: 86_400, previous: true },
                { action: "logs", pod: `${target.service}-0`, container: "migrate", tail: 1 },
                { action: "logs", container: "mesh-proxy" },
                ...(target.service === "orders-api" && target.environment === "staging" ? [{ action: "api", path: "/actuator/health?x=1" }] : []),
            ];
            for (const input of inputs) {
                const before = h.kubectl.calls().length;
                const result = await h.call({ service: target.service, environment: target.environment, ...input });
                assert.equal(result.blocked, undefined, JSON.stringify(input));
                const made = since(before);
                assert.ok(made.length > 0, `${JSON.stringify(input)} made no kubectl call`);
                for (const call of made) assert.deepEqual(problems(call.argv, target), [], `${target.service} ${target.environment} ${JSON.stringify(input)}: ${call.argv.join(" ")}`);
                total += made.length;
            }
        }
        assert.ok(total >= 40, `${total} calls were checked`);
    });

    test("is started as kubectl, by name, with an argument list, and no input", async () => {
        populate("orders-api");
        await h.call({ action: "pods", service: "orders-api", environment: "staging" });
        await h.call({ action: "logs", service: "orders-api", environment: "staging" });
        assert.ok(h.jig.started.length >= 3);
        for (const started of h.jig.started) {
            assert.equal(started.file, "kubectl");
            assert.ok(Array.isArray(started.args) && started.args.every((arg) => typeof arg === "string"));
            assert.equal(started.options.input, undefined);
        }
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
        const takes: Record<string, string[]> = { pods: [], status: ["waitFor"], logs: ["pod", "container"], api: ["path"] };
        // Paths that look like flags, verbs and commands but are legal paths: they reach curl as part of the address.
        const paths = ["/x;delete", "/x?--data=@/etc/passwd", "/$(id)", "/x?--context=other", "/%0a--all", "/-n", "/--token=abc", "/x?a=b&c=--proxy"];
        let blocked = 0;
        let ran = 0;
        for (const [action, names] of Object.entries(takes)) {
            for (const name of ["service", "environment", ...names]) {
                for (const value of name === "path" ? [...hostile, ...paths] : hostile) {
                    const before = h.kubectl.calls().length;
                    const input = { action, service: "orders-api", environment: "staging", ...(action === "api" ? { path: "/x" } : {}), [name]: value };
                    const result = await h.call(input);
                    if (result.blocked !== undefined) blocked++;
                    else ran++;
                    for (const call of since(before)) {
                        assert.deepEqual(problems(call.argv, TARGETS[0] as (typeof TARGETS)[number]), [], `${action} ${name}=${JSON.stringify(value)}: ${call.argv.join(" ")}`);
                    }
                }
            }
        }
        assert.ok(blocked > 200, `${blocked} calls were blocked`);
        assert.ok(ran >= 10, `${ran} calls ran: a value that is a legal name or path reaches kubectl, and still changes nothing`);
    });

    test("cannot name a verb, a flag, an argument list or a command", async () => {
        populate("orders-api");
        const before = h.kubectl.calls().length;
        const base = { action: "pods", service: "orders-api", environment: "staging" };
        for (const extra of [
            { verb: "delete" }, { command: "delete pod x" }, { args: ["delete", "pod", "x"] }, { argv: ["delete"] }, { flags: ["--all"] },
            { subcommand: "scale" }, { resource: "secrets" }, { kind: "secret" }, { output: "yaml" }, { selector: "app=other" }, { labels: "app=other" },
            { context: "other" }, { namespace: "kube-system" }, { cluster: "other" }, { kubeconfig: "/tmp/x" }, { allNamespaces: true }, { env: { A: "b" } },
            { stdin: "x" }, { shell: "sh -c id" }, { exec: "id" }, { cmd: "id" },
        ]) {
            const result = await h.call({ ...base, ...extra });
            assert.match(result.blocked ?? "", /^Blocked by jig-core: k8s cannot run with this input: k8s pods does not use /, JSON.stringify(extra));
        }
        assert.equal(since(before).length, 0);
    });

    test("cannot name an action that writes", async () => {
        for (const action of WRITING_VERBS) {
            const result = await h.call({ action, service: "orders-api", environment: "staging" });
            assert.match(result.blocked ?? "", /^Blocked by jig-core: k8s cannot run with this input: k8s: action must be one of pods, status, logs, api/, action);
        }
        assert.deepEqual(h.kubectl.calls(), []);
    });

    test("cannot reach a pod of another service, whatever the pod is called", async () => {
        populate("orders-api");
        const before = h.kubectl.calls().length;
        for (const pod of ["billing-0", "kube-apiserver-node-1", "delete", "orders-api-9", "orders-api-0.", "ORDERS-API-0"]) {
            const result = await h.call({ action: "logs", service: "orders-api", environment: "staging", pod });
            assert.ok(result.error !== undefined || result.blocked !== undefined, pod);
        }
        for (const call of since(before)) assert.equal(call.argv[3], "get", "only the service's own pods were listed; no log was asked for");
    });
});

describe("what the cluster sends", () => {
    test("a pod called after a verb is a pod, and the verb stays the verb", async () => {
        for (const name of WRITING_VERBS.filter((verb) => /^[a-z0-9-]+$/.test(verb) && !verb.startsWith("-") && !verb.endsWith("-"))) {
            h.kubectl.answer({ pods: list(pod(name, { service: "orders-api" })), logs: { stdout: "x\n" }, exec: { stdout: "{}\n__status:200" } });
            const before = h.kubectl.calls().length;
            const logs = await h.call({ action: "logs", service: "orders-api", environment: "staging" });
            const named = await h.call({ action: "logs", service: "orders-api", environment: "staging", pod: name });
            const api = await h.call({ action: "api", service: "orders-api", environment: "staging", path: "/x" });
            assert.equal(logs.error, undefined, name);
            assert.equal(named.error, undefined, name);
            assert.equal(api.error, undefined, name);
            const made = since(before);
            assert.ok(made.some((call) => call.argv[3] === "logs" && call.argv[4] === name), name);
            for (const call of made) assert.deepEqual(problems(call.argv, TARGETS[0] as (typeof TARGETS)[number]), [], `${name}: ${call.argv.join(" ")}`);
            assert.ok(made.every((call) => ["get", "logs", "exec"].includes(call.argv[3] ?? "")), name);
        }
    });

    test("a pod or a container whose name could be read as a flag is not used", async () => {
        const flagLike = pod("-A", { service: "orders-api" });
        const fine = pod("orders-api-0", { service: "orders-api" }) as { spec: { containers: Array<{ name: string; image: string }> } };
        fine.spec.containers.push({ name: "--all-containers", image: "registry.example.test/x:1" });
        h.kubectl.answer({ pods: list(flagLike, fine), logs: { stdout: "x\n" } });
        const pods = await h.call({ action: "pods", service: "orders-api", environment: "staging" });
        assert.match(pods.text, /^1 pod of /, "the flag-like pod is not a pod");
        assert.match(pods.text, /- orders-api-0: 1\/1 ready/, "and the flag-like container is not one of the pod's containers");
        await h.call({ action: "logs", service: "orders-api", environment: "staging" });
        const logs = h.kubectl.calls().find((call) => call.argv[3] === "logs");
        assert.deepEqual(logs?.argv.slice(3), ["logs", "orders-api-0", "-c", "orders-api", "--tail=200"]);
        for (const call of h.kubectl.calls()) assert.deepEqual(problems(call.argv, TARGETS[0] as (typeof TARGETS)[number]), []);
    });
});

describe("where the context and the namespace come from", () => {
    test("the configuration, for every service, as it is written there", async () => {
        const raw = section();
        const services = raw.services as Record<string, Record<string, Record<string, unknown>>>;
        (services["billing"] as Record<string, Record<string, unknown>>).staging = {
            context: "arn:aws:eks:eu-west-1:123456789012:cluster/test",
            namespace: "billing-9",
            selector: "app.kubernetes.io/name=billing",
        };
        h.configure(raw);
        populate("billing");
        await h.call({ action: "pods", service: "billing", environment: "staging" });
        assert.deepEqual(h.kubectl.calls()[0]?.argv.slice(0, 4), [
            "--request-timeout=25s",
            "--context=arn:aws:eks:eu-west-1:123456789012:cluster/test",
            "--namespace=billing-9",
            "get",
        ]);
        assert.equal(h.kubectl.calls()[0]?.argv[5], "--selector=app.kubernetes.io/name=billing");
    });

    test("the configuration of the moment: a change applies to the next call", async () => {
        populate("orders-api");
        await h.call({ action: "pods", service: "orders-api", environment: "staging" });
        const changed = section();
        ((changed.services as Record<string, Record<string, Record<string, unknown>>>)["orders-api"] as Record<string, Record<string, unknown>>).staging = {
            context: "moved-cluster",
            namespace: "moved",
            selector: "app=orders-api",
        };
        h.configure(changed);
        await h.call({ action: "pods", service: "orders-api", environment: "staging" });
        assert.deepEqual(h.kubectl.calls().map((call) => call.argv.slice(1, 3)), [
            ["--context=test-cluster", "--namespace=orders-staging"],
            ["--context=moved-cluster", "--namespace=moved"],
        ]);
    });

    test("a service the configuration lacks is never looked for", async () => {
        const result = await h.call({ action: "pods", service: "kube-system", environment: "staging" });
        assert.match(result.blocked ?? "", /no service named "kube-system"/);
        assert.deepEqual(h.kubectl.calls(), []);
    });
});

describe("the code", () => {
    const sources = fs
        .readdirSync(SRC)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => ({ file, text: fs.readFileSync(path.join(SRC, file), "utf8") }));
    /** The code of a file without its comments. */
    const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");

    test("starts kubectl in one file only, and builds its argument list in that file only", () => {
        const starting = sources.filter(({ text }) => /\.exec\.run\(/.test(codeOf(text))).map(({ file }) => file);
        assert.deepEqual(starting, ["kubectl.ts"]);
        const building = sources.filter(({ text }) => /request-timeout|--context|--namespace/.test(codeOf(text))).map(({ file }) => file);
        assert.deepEqual(building, ["kubectl.ts"]);
        for (const { file, text } of sources) {
            assert.ok(!/node:child_process|\bspawn\b|\bexecFile|\bexecSync\b|\bshell\s*:/.test(codeOf(text)), `${file} starts a process by itself`);
        }
    });

    test("names no verb that writes, in any string", () => {
        const verbs = WRITING_VERBS.filter((verb) => !["config", "wait", "set", "run", "events", "top", "describe", "plugin", "auth", "diff", "explain", "restart"].includes(verb));
        for (const { file, text } of sources) {
            for (const verb of verbs) {
                assert.ok(!new RegExp(`["'\`]${verb}["'\`]`).test(codeOf(text)), `${file} has the string "${verb}"`);
            }
        }
    });

    test("lists three verbs, and runKubectl asks the list", () => {
        const text = fs.readFileSync(path.join(SRC, "kubectl.ts"), "utf8");
        assert.match(codeOf(text), /export const VERBS = \["get", "logs", "exec"\] as const;/);
        assert.match(codeOf(text), /if \(!\(VERBS as readonly string\[\]\)\.includes\(verb\)\) \{\s*throw/);
    });
});
