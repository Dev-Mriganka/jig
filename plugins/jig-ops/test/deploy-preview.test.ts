// What the user is shown before a deploy or a rollback, how that is tied to what runs ("changed since the preview"), and the
// rule that a command whose outcome is unknown is never run again.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { history, list, pod, values, workload } from "./support/fixtures.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { withDeploy } from "./support/section.ts";
import { BILLING, billing, ORDERS, orders, UPGRADED } from "./support/worlds.ts";

let h: Harness;
afterEach(() => h.close());

const run = (version: string, where: Record<string, unknown> = ORDERS, options = {}) => h.deploy.call({ action: "run", ...where, version }, options);
const rollback = (where: Record<string, unknown> = ORDERS, options = {}) => h.deploy.call({ action: "rollback", ...where }, options);
const getsOf = (resource: string) => h.cluster.calls().filter((call) => call.argv[3] === "get" && call.argv[4] === resource).length;

/** orders-api, running 1.4.3, with a history to go back through. */
const rollbackWorld = (more = {}) =>
    orders("1.4.3", { helmHistory: history({ revision: 4 }, { revision: 5, status: "deployed" }), helmGetValues: values("1.4.2"), helmRollback: { stdout: "ok\n" }, ...more });

describe("the preview of a deploy", () => {
    beforeEach(() => void (h = setupHarness()));

    test("shows the service, the environment, the method, the versions and the exact command, on a review screen", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await run("1.4.3");
        const preview = result.preview;
        assert.equal(preview?.summary, "deploy 1.4.3 to orders-api in staging with helm (now 1.4.2)");
        assert.equal(preview?.format, "text");
        assert.equal(
            preview?.body,
            [
                "Service:       orders-api",
                "Environment:   staging (test)",
                "Method:        helm",
                "Running now:   1.4.2",
                "Deploying:     1.4.3",
                "Command:       helm upgrade --install orders-api deploy/chart --kube-context test-cluster --namespace orders-staging --set image.tag=1.4.3 --wait=false",
                "",
                "The command runs once, without a shell. If it is cut short, whether it took effect is unknown, and it is not run again.",
            ].join("\n"),
        );
        assert.match(preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);
    });

    test("shows a kubectl deploy with the whole argument list, context and namespace first", async () => {
        h.cluster.answer(billing("2.0.0"));
        const preview = (await run("2.1.0", BILLING)).preview;
        assert.equal(preview?.summary, "deploy 2.1.0 to billing in staging with kubectl-image (now 2.0.0)");
        assert.match(preview?.body ?? "", /\nCommand:       kubectl --request-timeout=50s --context=test-cluster --namespace=billing-staging set image deployment\/billing billing=registry\.example\.test\/shop\/billing:2\.1\.0\n/);
    });

    test("says when a rollout is in progress, and when the version is already running", async () => {
        h.cluster.answer(orders("1.4.2", { pods: list(pod("orders-api-0", { tag: "1.4.3" }), pod("orders-api-1", { tag: "1.4.2" })) }));
        assert.match((await run("1.4.4")).preview?.summary ?? "", /\(now 1\.4\.2, 1\.4\.3 \(a rollout is in progress\)\)$/);
        h.cluster.answer(orders("1.4.3"));
        assert.match((await run("1.4.3")).preview?.body ?? "", /\n\nNote: 1\.4\.3 is already running, so this changes the release and not the version\.$/);
    });

    test("reads the cluster and changes nothing: no helm, no write, and kubectl only gets", async () => {
        h.cluster.answer(orders("1.4.2"));
        const preview = await h.deploy.declaration.preview?.({ action: "run", ...ORDERS, version: "1.4.3" }, new AbortController().signal);
        assert.ok(preview);
        assert.deepEqual(h.cluster.helmCalls(), []);
        assert.deepEqual(h.cluster.calls().map((call) => call.argv[3]), ["get", "get"]);
    });

    test("for a rollback names the revision it goes back to and what it ran", async () => {
        h.cluster.answer(rollbackWorld());
        const preview = (await rollback()).preview;
        assert.equal(preview?.summary, "roll orders-api in staging back to revision 4, which ran 1.4.2 with helm (now 1.4.3)");
        assert.match(preview?.body ?? "", /\nGoing back to: revision 4, which ran 1\.4\.2\nCommand:       helm rollback orders-api --kube-context test-cluster --namespace orders-staging\n/);
    });

    test("a plan, a status and a watch have a one-line preview and no fingerprint: there is nothing to tie to a run", async () => {
        h.cluster.answer(orders("1.4.2"));
        const preview = h.deploy.declaration.preview;
        assert.ok(preview);
        const signal = new AbortController().signal;
        assert.deepEqual(await preview({ action: "plan", ...ORDERS, version: "1.4.3" }, signal), { summary: "plan the deploy of 1.4.3 to orders-api in staging" });
        assert.deepEqual(await preview({ action: "status", ...ORDERS }, signal), { summary: "show the last deploy and the rollout of orders-api in staging" });
        assert.deepEqual(await preview({ action: "watch", ...ORDERS, version: "1.4.3" }, signal), { summary: "watch the rollout of orders-api in staging to 1.4.3, in the background" });
        assert.deepEqual(h.cluster.calls(), []);
    });

    test("is refused for a call that may not run, like the call itself", async () => {
        const preview = h.deploy.declaration.preview;
        assert.ok(preview);
        const signal = new AbortController().signal;
        await assert.rejects(
            preview({ action: "run", service: "orders-api", environment: "production", version: "1.4.3" }, signal),
            (error: unknown) => error instanceof TypeError && /^deploy run is refused: orders-api in production is production/.test(error.message),
        );
        await assert.rejects(preview({ action: "run", ...ORDERS, version: "--force" }, signal), (error: unknown) => error instanceof TypeError && /version must be an image tag/.test(error.message));
        assert.deepEqual(h.jig.started, []);
    });

    test("a cluster that cannot be read leaves the preview unavailable, and the run reads it again and refuses to go blind", async () => {
        h.cluster.answer({ pods: { code: 1, stderr: "Unable to connect to the server: dial tcp: i/o timeout" }, helmUpgrade: { stdout: UPGRADED } });
        const result = await run("1.4.3");
        assert.equal(result.preview, undefined, "no preview could be made");
        assert.match(result.error?.message ?? "", /^Cannot reach the cluster/);
        assert.deepEqual(h.cluster.helmCalls(), []);
    });

    test("a bug while making the preview is not reported as the model's mistake", async () => {
        h.jig.api.config.section = () => {
            throw new TypeError("a bug, not an input");
        };
        await assert.rejects(
            h.deploy.declaration.preview?.({ action: "run", ...ORDERS, version: "1.4.3" }, new AbortController().signal) as Promise<unknown>,
            (error: unknown) => error instanceof Error && !(error instanceof TypeError) && error.message === "internal error: a bug, not an input",
        );
    });
});

describe("the fingerprint", () => {
    beforeEach(() => void (h = setupHarness()));

    const fingerprint = async (input: Record<string, unknown>) => {
        const preview = await h.deploy.declaration.preview?.(input, new AbortController().signal);
        return preview?.fingerprint;
    };
    const RUN = { action: "run", ...ORDERS, version: "1.4.3" };

    test("is the same for the same call on the same cluster, however often it is made", async () => {
        h.cluster.answer(orders("1.4.2"));
        assert.equal(await fingerprint(RUN), await fingerprint(RUN));
    });

    test("changes with the version asked for, the versions running, the environment, the service and the command", async () => {
        h.cluster.answer(orders("1.4.2"));
        const base = await fingerprint(RUN);
        assert.notEqual(await fingerprint({ ...RUN, version: "1.4.4" }), base, "the version asked for");
        h.cluster.answer(orders("1.4.1"));
        assert.notEqual(await fingerprint(RUN), base, "the version running");
        h.cluster.answer(orders("1.4.2", { pods: list(pod("orders-api-0", { tag: "1.4.2" }), pod("orders-api-1", { tag: "1.4.3" })) }));
        assert.notEqual(await fingerprint(RUN), base, "a rollout in progress");
        h.cluster.answer(billing("2.0.0"));
        assert.notEqual(await fingerprint({ action: "run", ...BILLING, version: "1.4.3" }), base, "the service and its method");
        h.cluster.answer(orders("1.4.2"));
        h.configure(withDeploy("orders-api", "staging", { valuesFile: "deploy/values.yaml" }));
        assert.notEqual(await fingerprint(RUN), base, "the command");
        h.configure(withDeploy("orders-api", "staging", { release: "orders-api-2" }));
        assert.notEqual(await fingerprint(RUN), base, "the release");
    });

    test("does not change when pods are scaled or become unready: those are not a change of version", async () => {
        h.cluster.answer(orders("1.4.2"));
        const base = await fingerprint(RUN);
        h.cluster.answer(orders("1.4.2", { pods: list(pod("orders-api-0"), pod("orders-api-1"), pod("orders-api-2")) }));
        assert.equal(await fingerprint(RUN), base, "a third pod of the same version");
        h.cluster.answer(orders("1.4.2", { pods: list(pod("orders-api-0", { ready: false, waiting: "CrashLoopBackOff", restarts: 9 }), pod("orders-api-1")) }));
        assert.equal(await fingerprint(RUN), base, "a pod that is not ready");
    });

    test("tells a deploy from a rollback of the same service", async () => {
        h.cluster.answer(rollbackWorld());
        assert.notEqual(await fingerprint({ action: "rollback", ...ORDERS }), await fingerprint({ action: "run", ...ORDERS, version: "1.4.2" }));
    });
});

describe("changed since the preview", () => {
    beforeEach(() => void (h = setupHarness()));

    test("a version that came to run while the user read the preview: refused, with what runs now, and nothing started", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await run("1.4.3", ORDERS, { between: () => h.cluster.answer(orders("1.4.3")) });
        assert.equal(
            result.error?.message,
            "deploy run of orders-api in staging changed since the preview (it is running 1.4.3 now); run it again to see the new preview. Nothing was run",
        );
        assert.deepEqual(h.cluster.helmCalls(), []);
        assert.deepEqual(h.jig.started.filter((one) => one.file === "helm"), []);
    });

    test("a rollout someone else began while the user read it: refused", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await run("1.4.4", ORDERS, {
            between: () => h.cluster.answer(orders("1.4.2", { pods: list(pod("orders-api-0", { tag: "1.4.3" }), pod("orders-api-1", { tag: "1.4.2" })) })),
        });
        assert.match(result.error?.message ?? "", /changed since the preview \(it is running 1\.4\.2, 1\.4\.3 \(a rollout is in progress\) now\)/);
        assert.deepEqual(h.cluster.helmCalls(), []);
    });

    test("a catalog that was edited while the user read it, so that the command is another: refused", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await run("1.4.3", ORDERS, { between: () => h.configure(withDeploy("orders-api", "staging", { valuesFile: "deploy/values-other.yaml" })) });
        assert.match(result.error?.message ?? "", /changed since the preview/);
        assert.deepEqual(h.cluster.helmCalls(), []);
    });

    test("the same for kubectl: the image that is set is tied to the preview too", async () => {
        h.cluster.answer(billing("2.0.0"));
        const other = workload("billing", { service: "billing", kind: "Deployment" }) as { spec: { template: { spec: { containers: Array<{ image: string }> } } } };
        (other.spec.template.spec.containers[0] as { image: string }).image = "registry.other.test/billing:2.0.0";
        const result = await run("2.1.0", BILLING, { between: () => h.cluster.answer(billing("2.0.0", { workload: { stdout: other as never } })) });
        assert.match(result.error?.message ?? "", /^deploy run of billing in staging changed since the preview/);
        assert.deepEqual(h.cluster.calls().filter((call) => call.argv[3] === "set"), []);
    });

    test("a rollback whose revision moved while the user read it: refused", async () => {
        h.cluster.answer(rollbackWorld());
        const result = await rollback(ORDERS, { between: () => h.cluster.answer(rollbackWorld({ helmHistory: history({ revision: 5 }, { revision: 6, status: "deployed" }) })) });
        assert.match(result.error?.message ?? "", /^deploy rollback of orders-api in staging changed since the preview/);
        assert.equal(h.cluster.helmCalls().filter((call) => call.argv[0] === "rollback").length, 0);
    });

    test("a rollback to a revision that ran another version than the user was shown: refused", async () => {
        h.cluster.answer(rollbackWorld());
        const result = await rollback(ORDERS, { between: () => h.cluster.answer(rollbackWorld({ helmGetValues: values("1.3.9") })) });
        assert.match(result.error?.message ?? "", /changed since the preview/);
        assert.equal(h.cluster.helmCalls().filter((call) => call.argv[0] === "rollback").length, 0);
    });

    test("nothing changed: it runs, and runs what was shown", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await run("1.4.3");
        assert.equal(result.error, undefined);
        assert.equal(h.cluster.helmCalls().length, 1);
        assert.equal(h.jig.api.approvedPreview(result.id)?.fingerprint, result.preview?.fingerprint);
    });

    test("pods scaled or unready in the meantime are not a change", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await run("1.4.3", ORDERS, { between: () => h.cluster.answer(orders("1.4.2", { pods: list(pod("orders-api-0"), pod("orders-api-1", { ready: false })) })) });
        assert.equal(result.error, undefined);
        assert.equal(h.cluster.helmCalls().length, 1);
    });

    test("a call a rule allowed has no approved preview, so there is nothing to compare, and it runs", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await run("1.4.3", ORDERS, { allowed: true, between: () => h.cluster.answer(orders("1.4.3")) });
        assert.equal(result.preview, undefined);
        assert.equal(result.error, undefined);
        assert.equal(h.cluster.helmCalls().length, 1);
    });
});

describe("a command whose outcome is unknown is never run again", () => {
    beforeEach(() => void (h = setupHarness({ writeTimeoutMs: 250 })));

    /** What jig-core returns for a program that took too long and was stopped, for the commands that change the cluster. */
    const TOO_SLOW = { code: 124, stdout: "", stderr: "", timedOut: true };
    const changes = (file: string, args: readonly string[]) =>
        (file === "helm" && (args[0] === "upgrade" || args[0] === "rollback")) || (file === "kubectl" && (args[3] === "set" || args[3] === "rollout"));
    /** Makes every command that changes the cluster run out of time. The reads work. */
    const tooSlow = () => {
        h.jig.script = (file, args) => (changes(file, args) ? TOO_SLOW : undefined);
    };
    /** How many times a command that changes the cluster was started, by the plugin, whatever it did. */
    const started = (file: string) => h.jig.started.filter((one) => changes(one.file, one.args) && one.file === file).length;

    test("helm that runs too long is stopped, the rollout is read once, and nothing is sent again", async () => {
        h.cluster.answer(orders("1.4.2"));
        tooSlow();
        const result = await run("1.4.3");
        const message = result.error?.message ?? "";
        assert.match(
            message,
            /^deploy run: helm ran longer than 0\.25 s and was stopped, so it is unknown whether the deploy of 1\.4\.3 took effect in orders-api in staging\. It was not run again\. One look at the rollout now:\n/,
        );
        assert.match(message, /\norders-api in staging \(namespace orders-staging\): Still rolling: 0 of 2 pods ready on 1\.4\.3; pods run 1\.4\.2\.\n/);
        assert.match(message, /\nCheck with deploy status before doing anything else, and tell the user\. Do not run it again unless the user says so$/);
        assert.equal(started("helm"), 1, "helm was started once");
        // The preview read the rollout, the run read it again before it started helm, and the look after it read it once.
        assert.equal(getsOf("pods"), 3);
        assert.equal(getsOf("deployments,statefulsets"), 3);
        assert.deepEqual(h.jig.facts.get(result.id), [{ method: "helm", outcome: "unknown" }]);
    });

    test("the same with a helm that really takes too long: the time limit stops the process", async () => {
        h.close();
        h = setupHarness({ writeTimeoutMs: 1500 });
        h.cluster.answer(orders("1.4.2", { helmUpgrade: { stdout: UPGRADED, delayMs: 20_000 } }));
        const started_ = Date.now();
        const result = await run("1.4.3");
        assert.match(result.error?.message ?? "", /^deploy run: helm ran longer than 1\.5 s and was stopped, so it is unknown whether the deploy of 1\.4\.3 took effect/);
        assert.ok(Date.now() - started_ < 15_000, "the process was stopped at the limit, not left to finish");
        assert.equal(h.jig.started.filter((one) => one.file === "helm").length, 1);
        assert.match(result.error?.message ?? "", /Still rolling: 0 of 2 pods ready on 1\.4\.3/);
    });

    test("status afterwards says it was cut short, and that it was not run again", async () => {
        h.cluster.answer(orders("1.4.2"));
        tooSlow();
        await run("1.4.3");
        h.cluster.answer(orders("1.4.2"));
        const first = ok(await h.deploy.call({ action: "status", ...ORDERS })).split("\n")[0];
        assert.equal(first, "Last run from here: the deploy of 1.4.3 with helm, 0s ago, while 1.4.2 was running: cut short, so whether it took effect is unknown, and it was not run again.");
    });

    test("a call the user cancelled while helm ran is the same, and the one look is made even so", async () => {
        h.cluster.answer(orders("1.4.2", { helmUpgrade: { stdout: UPGRADED, delayMs: 20_000 } }));
        const controller = new AbortController();
        const running = run("1.4.3", ORDERS, { signal: controller.signal });
        // The user cancels once helm has started, however long the reads before it took.
        const watching = setInterval(() => {
            if (h.cluster.helmCalls().length === 0) return;
            clearInterval(watching);
            controller.abort();
        }, 10);
        const result = await running;
        clearInterval(watching);
        assert.match(result.error?.message ?? "", /^deploy run: the call was cancelled while helm ran, so it is unknown whether the deploy of 1\.4\.3 took effect/);
        assert.match(result.error?.message ?? "", /Still rolling: 0 of 2 pods ready on 1\.4\.3/, "the look was made with the signal already aborted");
        assert.equal(started("helm"), 1);
        assert.equal(getsOf("pods"), 3);
        const lookStart = h.jig.started.filter((one) => one.file === "kubectl").at(-1);
        assert.equal(lookStart?.options.signal, undefined, "the look does not carry the signal that was aborted");
    });

    test("kubectl set image that runs too long is the same, and is not set again", async () => {
        h.cluster.answer(billing("2.0.0"));
        tooSlow();
        const result = await run("2.1.0", BILLING);
        assert.match(result.error?.message ?? "", /^deploy run: kubectl ran longer than 0\.25 s and was stopped, so it is unknown whether the deploy of 2\.1\.0 took effect in billing in staging\. It was not run again\./);
        assert.equal(started("kubectl"), 1);
    });

    test("a rollback that runs too long is the same, with no version to judge the look by", async () => {
        h.cluster.answer(rollbackWorld());
        tooSlow();
        const result = await rollback();
        assert.match(result.error?.message ?? "", /^deploy rollback: helm ran longer than 0\.25 s and was stopped, so it is unknown whether the rollback took effect in orders-api in staging\. It was not run again\./);
        assert.equal(started("helm"), 1);
    });

    test("when the look fails too, that is said, and the look is not repeated", async () => {
        h.cluster.answer(orders("1.4.2"));
        let reads = 0;
        h.jig.script = (file, args) => {
            if (changes(file, args)) return TOO_SLOW;
            // The first two reads (preview, then plan) work; the one after the cut-short helm does not.
            if (file === "kubectl" && args[3] === "get" && args[4] === "pods" && ++reads > 2) {
                return { code: 1, stdout: "", stderr: "Unable to connect to the server: dial tcp: i/o timeout", timedOut: false };
            }
            return undefined;
        };
        const result = await run("1.4.3");
        assert.match(result.error?.message ?? "", /One look at the rollout now:\nThe rollout could not be read either: Cannot reach the cluster of context test-cluster for orders-api in staging/);
        assert.equal(reads, 3, "one failed look, and no second try");
        assert.equal(started("helm"), 1);
    });

    test("a command that finishes in time is not an unknown outcome", async () => {
        h.close();
        h = setupHarness();
        h.cluster.answer(orders("1.4.2", { helmUpgrade: { stdout: UPGRADED, delayMs: 50 } }));
        const result = await run("1.4.3");
        assert.equal(result.error, undefined);
        assert.match(result.text, /^Started the deploy of 1\.4\.3/);
    });
});
