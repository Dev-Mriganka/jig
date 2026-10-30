// The only writes this plugin can make are `helm upgrade --install`, `helm rollback`, `kubectl set image` and `kubectl rollout
// undo`, and only the deploy tool runs them. Every helm and kubectl command line of every deploy call is checked against the few
// shapes the plugin can build (see support/argv.ts), with versions that are odd but allowed, and with the commands that must
// not exist asked for directly. The read-only tool has the same kind of test in readonly.test.ts.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { startHelm } from "../src/deploy/helm.ts";
import { startKubectl } from "../src/runtime/kubernetes/kubectl.ts";
import { helmProblems, problems } from "./support/argv.ts";
import { controllerRevision, history, list, replicaSet, values } from "./support/fixtures.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { rig } from "./support/rig.ts";
import type { Rig } from "./support/rig.ts";
import { withDeploy, withEnvironment } from "./support/section.ts";
import { codeOf, sources } from "./support/sources.ts";
import { BILLING, billing, ORDERS, orders } from "./support/worlds.ts";

const STAGING = { context: "test-cluster", namespace: "orders-staging", release: "orders-api" };
const BILLING_STAGING = { context: "test-cluster", namespace: "billing-staging" };

describe("every command a deploy builds", () => {
    let h: Harness;
    beforeEach(() => void (h = setupHarness()));
    afterEach(() => h.close());

    /** Versions that are allowed, and odd enough to find a command line that treats one badly. */
    const ODD = ["1.4.3", "v1", "_", "0", "A", "a.b-c_d", "1.2.3-rc.1", "sha-0123456789abcdef", "latest", "1-", "9".repeat(128), "x_y.z-w", "rollback", "upgrade", "delete", "set", "image", "wait"];

    test("helm upgrade has the shape of the one command it builds, and the version changes one argument and nothing else", async () => {
        const upgrade = async (version: string) => {
            h.cluster.answer(orders("1.4.2"));
            const before = h.cluster.helmCalls().length;
            const result = await h.deploy.call({ action: "run", ...ORDERS, version });
            assert.equal(result.error, undefined, version);
            const calls = h.cluster.helmCalls().slice(before);
            assert.equal(calls.length, 1, version);
            return (calls[0] as { argv: string[] }).argv;
        };
        const withoutVersion = (argv: string[]) => argv.filter((arg) => !arg.startsWith("image.tag="));
        const reference = withoutVersion(await upgrade("0.0.0"));
        for (const version of ODD) {
            const argv = await upgrade(version);
            assert.deepEqual(helmProblems(argv, STAGING), [], `${version}: ${argv.join(" ")}`);
            assert.equal(argv.filter((arg) => arg === `image.tag=${version}`).length, 1, version);
            assert.equal(argv[argv.length - 2], `image.tag=${version}`, "the version is the last --set, so nothing can win over it");
            assert.deepEqual(withoutVersion(argv), reference, `${version} changed more than the image tag`);
        }
    });

    test("kubectl set image has the shape of the one command it builds, for every version", async () => {
        for (const version of ODD) {
            h.cluster.answer(billing("2.0.0"));
            const before = h.cluster.calls().length;
            const result = await h.deploy.call({ action: "run", ...BILLING, version });
            assert.equal(result.error, undefined, version);
            for (const call of h.cluster.calls().slice(before)) assert.deepEqual(problems(call.argv, BILLING_STAGING), [], `${version}: ${call.argv.join(" ")}`);
            const set = h.cluster.calls().slice(before).find((call) => call.argv[3] === "set");
            assert.equal(set?.argv[6], `billing=registry.example.test/shop/billing:${version}`, version);
        }
    });

    test("every flow, deploys, rollbacks, plans, status and the reads in front of them, makes only commands of a known shape", async () => {
        h.cluster.answer(orders("1.4.3", { helmHistory: history({ revision: 4 }, { revision: 5 }), helmGetValues: values("1.4.2"), helmRollback: { stdout: "ok\n" } }));
        await h.deploy.call({ action: "plan", ...ORDERS, version: "1.4.4" });
        await h.deploy.call({ action: "run", ...ORDERS, version: "1.4.4" });
        await h.deploy.call({ action: "rollback", ...ORDERS });
        await h.deploy.call({ action: "status", ...ORDERS });
        await h.deploy.call({ action: "watch", ...ORDERS, version: "1.4.4" });
        h.cluster.answer(billing("2.0.0", {
            replicasets: list(replicaSet("b-1", { service: "billing", owner: "billing", revision: 1 }), replicaSet("b-2", { service: "billing", owner: "billing", revision: 2 })),
            rolloutUndo: { stdout: "ok\n" },
        }));
        await h.deploy.call({ action: "plan", ...BILLING, version: "2.1.0" });
        await h.deploy.call({ action: "run", ...BILLING, version: "2.1.0" });
        await h.deploy.call({ action: "rollback", ...BILLING });
        await h.deploy.call({ action: "status", ...BILLING });
        const kubectl = h.cluster.calls();
        const helm = h.cluster.helmCalls();
        assert.ok(kubectl.length >= 20 && helm.length >= 6, `${kubectl.length} kubectl and ${helm.length} helm calls were checked`);
        for (const call of kubectl) {
            const target = call.argv[2] === "--namespace=billing-staging" ? BILLING_STAGING : STAGING;
            assert.deepEqual(problems(call.argv, target), [], call.argv.join(" "));
        }
        for (const call of helm) assert.deepEqual(helmProblems(call.argv, STAGING), [], call.argv.join(" "));
        assert.deepEqual(new Set(helm.map((call) => call.argv[0])), new Set(["upgrade", "history", "get", "rollback"]));
        assert.deepEqual(new Set(kubectl.filter((call) => call.argv[3] !== "get").map((call) => `${call.argv[3]} ${call.argv[4]}`)), new Set(["set image", "rollout undo"]));
    });

    test("a stateful set's revisions are read with a get, as a deployment's", async () => {
        h.configure(withEnvironment("billing", "staging", { deploy: { method: "kubectl-image", workload: "statefulset/ledger", container: "ledger" } }));
        h.cluster.answer(billing("2.0.0", {
            controllerrevisions: list(controllerRevision("l-1", { revision: 1 }), controllerRevision("l-2", { revision: 2 })),
            rolloutUndo: { stdout: "ok\n" },
        }));
        await h.deploy.call({ action: "rollback", ...BILLING });
        for (const call of h.cluster.calls()) assert.deepEqual(problems(call.argv, BILLING_STAGING), [], call.argv.join(" "));
        assert.ok(h.cluster.calls().some((call) => call.argv[4] === "controllerrevisions"));
    });

    test("a catalog with a values file and values still builds a command of the same shape", async () => {
        h.configure(withDeploy("orders-api", "staging", { valuesFile: "/etc/deploy/values.yaml", set: { replicaCount: 3, "a.b[0].c": "x", "ingress.host": "o.example.test", flag: false } }));
        h.cluster.answer(orders("1.4.2"));
        await h.deploy.call({ action: "run", ...ORDERS, version: "1.4.3" });
        for (const call of h.cluster.helmCalls()) assert.deepEqual(helmProblems(call.argv, STAGING), [], call.argv.join(" "));
    });

    test("no flag that skips a check, forces a change, waits, or reads the environment is ever built", async () => {
        h.cluster.answer(orders("1.4.2", { helmHistory: history({ revision: 4 }, { revision: 5 }), helmGetValues: values("1.4.2"), helmRollback: { stdout: "ok\n" } }));
        await h.deploy.call({ action: "run", ...ORDERS, version: "1.4.3" });
        await h.deploy.call({ action: "rollback", ...ORDERS });
        const words = h.cluster.helmCalls().flatMap((call) => call.argv);
        for (const flag of ["--force", "--atomic", "--wait", "--cleanup-on-fail", "--reset-values", "--reuse-values", "--no-hooks", "--skip-crds", "--insecure-skip-tls-verify", "--dry-run", "--kubeconfig", "--kube-token", "--kube-apiserver", "--kube-as-user", "--create-namespace", "--devel", "--plain-http", "--post-renderer", "--timeout", "--set-file", "--set-json", "--set-string", "--version", "--repo", "--username", "--password"]) {
            assert.ok(!words.includes(flag), flag);
        }
    });
});

describe("the commands that must not exist", () => {
    let r: Rig;
    beforeEach(() => void (r = rig()));
    afterEach(() => r.close());
    const NOT_HELM = [
        ["uninstall", "orders-api"], ["delete", "orders-api"], ["install", "orders-api", "deploy/chart"], ["upgrade", "orders-api", "deploy/chart"], ["upgrade", "--reuse-values"],
        ["get", "all", "orders-api"], ["get", "manifest", "orders-api"], ["get", "hooks", "orders-api"], ["get", "notes", "orders-api"], ["get", "metadata", "orders-api"], ["get"],
        ["repo", "add", "x", "https://x.test"], ["repo", "update"], ["plugin", "install", "https://x.test/p"], ["pull", "x/y"], ["push", "x", "oci://x"], ["template", "x"], ["lint", "x"],
        ["test", "orders-api"], ["status", "orders-api"], ["list"], ["env"], ["registry", "login", "x"], ["dependency", "update"], ["package", "x"], ["create", "x"], ["show", "all", "x"],
        ["search", "hub", "x"], ["verify", "x"], ["version"], ["completion", "bash"], ["", "upgrade"], [],
    ];

    test("helm is started for upgrade --install, rollback, history and get values, and for nothing else", async () => {
        for (const args of NOT_HELM) {
            await assert.rejects(startHelm(r.kube(), args, { timeoutMs: 1000, maxBytes: 1000 }), (error: Error) => /^helm .*is not allowed: the tools run only upgrade --install, rollback, history and get values$/.test(error.message), JSON.stringify(args));
        }
        assert.equal(r.jig.started.length, 0, "no helm was started for any of them");
        r.cluster.answer({ helmUpgrade: { stdout: "" }, helmRollback: { stdout: "" }, helmHistory: { stdout: "[]" }, helmGetValues: { stdout: "{}" } });
        for (const args of [["upgrade", "--install", "orders-api", "deploy/chart"], ["rollback", "orders-api"], ["history", "orders-api"], ["get", "values", "orders-api"]]) {
            const result = await startHelm(r.kube(), args, { timeoutMs: 5000, maxBytes: 1000 });
            assert.equal(result.code, 0, args.join(" "));
        }
        assert.deepEqual(r.cluster.helmCalls().map((call) => call.argv[0]), ["upgrade", "rollback", "history", "get"]);
    });

    test("kubectl is started for get, logs, exec, set image and rollout undo, and for nothing else", async () => {
        const verbs = ["delete", "scale", "apply", "edit", "patch", "replace", "create", "run", "expose", "autoscale", "port-forward", "cp", "attach", "label", "annotate", "taint", "cordon", "uncordon", "drain", "certificate", "auth", "config", "proxy", "debug", "diff", "kustomize", "wait", "describe", "top", "events", "explain", "api-resources", "plugin", "completion", "rollout", "set"];
        for (const verb of verbs) {
            for (const args of [[], ["restart", "deployment/x"], ["resources", "deployment/x"], ["pause", "deployment/x"], ["env", "deployment/x"], ["status", "deployment/x"], ["history", "deployment/x"], ["undo --to-revision=1"]]) {
                await assert.rejects(startKubectl(r.kube(), verb as never, args, { timeoutMs: 1000, requestSec: 1, maxBytes: 1000 }), /is not allowed: the tools run only get, logs, exec, set image and rollout undo$/, `${verb} ${args.join(" ")}`);
            }
        }
        assert.equal(r.jig.started.length, 0);
    });
});

describe("the code", () => {
    const all = sources();
    const where = (pattern: RegExp) => all.filter(({ text }) => pattern.test(codeOf(text))).map(({ file }) => file);

    test("starts programs in two files, and each builds the arguments of its own program", () => {
        assert.deepEqual(where(/\.exec\.run\(/), ["deploy/helm.ts", "runtime/kubernetes/kubectl.ts"]);
        assert.deepEqual(where(/exec\.run\(\s*"helm"/), ["deploy/helm.ts"]);
        assert.deepEqual(where(/exec\.run\(\s*"kubectl"/), ["runtime/kubernetes/kubectl.ts"]);
        assert.deepEqual(where(/--kube-context/), ["deploy/helm.ts"]);
        assert.deepEqual(where(/--request-timeout|--context=|--namespace=/), ["runtime/kubernetes/kubectl.ts"]);
    });

    test("names the helm commands it can start in one list, and the runner asks the list", () => {
        const text = codeOf(all.find((source) => source.file === "deploy/helm.ts")?.text ?? "");
        assert.match(text, /return \(\s*\(command === "upgrade" && next === "--install"\) \|\|\s*command === "rollback" \|\|\s*command === "history" \|\|\s*\(command === "get" && next === "values"\)\s*\);/);
        assert.match(text, /if \(!allowed\(args\)\) \{\s*throw/);
        for (const word of ["install", "uninstall", "delete", "template", "pull", "push", "repo", "plugin", "dependency", "registry"]) {
            assert.ok(!new RegExp(`["'\`]${word}["'\`]`).test(text), `helm.ts has the string "${word}"`);
        }
    });

    test("the read-only tool cannot reach a write: nothing under runtime/ imports the deploy methods, the deploy tool or the watch", () => {
        for (const { file, text } of all.filter((source) => source.file.startsWith("runtime/"))) {
            for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
                const specifier = match[1] as string;
                assert.ok(!/deploy\/|\/watch\.ts$|^\.\.\/watch\.ts$/.test(specifier), `${file} imports ${specifier}`);
            }
        }
    });

    test("only the deploy actions start a command that changes the cluster", () => {
        const callers = where(/startHelm\(|startKubectl\(/);
        assert.deepEqual(callers, ["deploy/execute.ts", "deploy/helm.ts", "runtime/kubernetes/kubectl.ts"]);
    });
});
