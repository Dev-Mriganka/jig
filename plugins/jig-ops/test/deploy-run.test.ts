// `deploy run` and `deploy rollback`: the writes. A fake helm and a fake kubectl on a temporary PATH record the exact argument
// lists they are started with, so these tests can say what a deploy is allowed to do and what it is not, and what happens when
// a command fails.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { controllerRevision, history, list, replicaSet, values, workload } from "./support/fixtures.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { section, withDeploy, withEnvironment } from "./support/section.ts";
import { BILLING, billing, ORDERS, orders, setImageArgs, UPGRADED, upgradeArgs } from "./support/worlds.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

const run = (version: string, where: Record<string, unknown> = ORDERS, options = {}) => h.deploy.call({ action: "run", ...where, version }, options);
const rollback = (where: Record<string, unknown> = ORDERS, options = {}) => h.deploy.call({ action: "rollback", ...where }, options);
const started = (file: string) => h.jig.started.filter((one) => one.file === file);

describe("run with helm", () => {
    test("starts helm upgrade --install once, with the release and chart of the catalog, the context and namespace of its cluster, and the version", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await run("1.4.3");
        assert.deepEqual(h.cluster.helmCalls().map((call) => call.argv), [upgradeArgs("1.4.3")]);
        assert.deepEqual(result.cls, { action: "run", environment: "staging", effect: "write" });
        assert.deepEqual(h.jig.facts.get(result.id), [{ method: "helm", outcome: "started" }]);
    });

    test("tells the model what was started, that nothing waits for the rollout, and the first lines helm printed", async () => {
        h.cluster.answer(orders("1.4.2"));
        assert.equal(
            ok(await run("1.4.3")),
            [
                "Started the deploy of 1.4.3 to orders-api in staging with helm (it was running 1.4.2). Nothing waits for the rollout: deploy watch with version 1.4.3 reports when it ends, or runtime rollout with waitFor.",
                ...UPGRADED.trim().split("\n"),
            ].join("\n"),
        );
    });

    test("starts it with the limits of a change: six minutes, 1 MiB of output, the call's signal, no input", async () => {
        h.cluster.answer(orders("1.4.2"));
        const controller = new AbortController();
        ok(await run("1.4.3", ORDERS, { signal: controller.signal }));
        const [helm] = started("helm");
        assert.equal(helm?.options.timeoutMs, 6 * 60_000);
        assert.equal(helm?.options.maxOutputBytes, 1024 * 1024);
        assert.equal(helm?.options.signal, controller.signal);
        assert.equal(helm?.options.input, undefined);
        assert.deepEqual(helm?.options.env, {});
    });

    test("passes on where the kubeconfig is, as kubectl does, and nothing else of Pi's environment", async () => {
        h.cluster.answer(orders("1.4.2"));
        const saved = process.env.KUBECONFIG;
        try {
            process.env.KUBECONFIG = "/tmp/some/kubeconfig";
            ok(await run("1.4.3"));
        } finally {
            if (saved === undefined) delete process.env.KUBECONFIG;
            else process.env.KUBECONFIG = saved;
        }
        assert.deepEqual(started("helm").map((one) => one.options.env), [{ KUBECONFIG: "/tmp/some/kubeconfig" }]);
        assert.deepEqual(h.cluster.helmCalls().map((call) => call.kubeconfig), ["/tmp/some/kubeconfig"]);
    });

    test("adds the values file and the --set pairs of the catalog, and puts the version after them so that nothing can win over it", async () => {
        h.configure(withDeploy("orders-api", "staging", {
            valuesFile: "deploy/values-staging.yaml",
            set: { replicaCount: 2, "ingress.host": "orders.staging.example.com", debug: true },
        }));
        h.cluster.answer(orders("1.4.2"));
        ok(await run("1.4.3"));
        assert.deepEqual(h.cluster.helmCalls().map((call) => call.argv), [
            [
                "upgrade", "--install", "orders-api", "deploy/chart",
                "--kube-context", "test-cluster", "--namespace", "orders-staging",
                "--values", "deploy/values-staging.yaml",
                "--set", "replicaCount=2", "--set", "ingress.host=orders.staging.example.com", "--set", "debug=true",
                "--set", "image.tag=1.4.3",
                "--wait=false",
            ],
        ]);
    });

    test("never takes the release, the chart, the context, the namespace or a value from the call", async () => {
        h.cluster.answer(orders("1.4.2"));
        for (const extra of [{ release: "other" }, { chart: "evil/chart" }, { context: "prod-cluster" }, { namespace: "kube-system" }, { set: "x=y" }, { valuesFile: "/etc/passwd" }]) {
            const result = await h.deploy.call({ action: "run", ...ORDERS, version: "1.4.3", ...extra });
            assert.match(result.blocked ?? "", /^Blocked by jig-core: deploy cannot run with this input: deploy run does not use /, JSON.stringify(extra));
        }
        assert.deepEqual(h.cluster.helmCalls(), []);
        assert.deepEqual(h.jig.started, []);
    });
});

describe("run with kubectl set image", () => {
    test("reads the image from the workload as it is, and puts only the new tag on it", async () => {
        h.cluster.answer(billing("2.0.0"));
        const result = await run("2.1.0", BILLING);
        assert.equal(
            ok(result),
            [
                "Started the deploy of 2.1.0 to billing in staging with kubectl-image (it was running 2.0.0). Nothing waits for the rollout: deploy watch with version 2.1.0 reports when it ends, or runtime rollout with waitFor.",
                "deployment.apps/billing image updated",
            ].join("\n"),
        );
        const sets = h.cluster.calls().filter((call) => call.argv[3] === "set");
        assert.deepEqual(sets.map((call) => call.argv), [setImageArgs("registry.example.test/shop/billing:2.1.0")]);
        assert.deepEqual(result.cls, { action: "run", environment: "staging", effect: "write" });
        assert.deepEqual(h.cluster.helmCalls(), []);
    });

    test("changes the one container of the catalog, and not the sidecar next to it", async () => {
        h.cluster.answer(billing("2.0.0"));
        ok(await run("2.1.0", BILLING));
        const set = h.cluster.calls().find((call) => call.argv[3] === "set");
        assert.equal(set?.argv.length, 7, "one container, one assignment");
        assert.ok(!set?.argv.some((arg) => arg.includes("mesh-proxy")));
    });

    test("takes the tag and the digest off, and keeps the registry and the repository", async () => {
        for (const [image, expected] of [
            ["registry.example.test/shop/billing:2.0.0@sha256:0123abcd", "registry.example.test/shop/billing:2.1.0"],
            ["registry.example.test/shop/billing@sha256:0123abcd", "registry.example.test/shop/billing:2.1.0"],
            ["registry.example.test:5000/shop/billing", "registry.example.test:5000/shop/billing:2.1.0"],
            ["registry.example.test:5000/shop/billing:latest", "registry.example.test:5000/shop/billing:2.1.0"],
            ["billing", "billing:2.1.0"],
        ] as const) {
            const spec = workload("billing", { service: "billing", kind: "Deployment" }) as { spec: { template: { spec: { containers: Array<{ name: string; image: string }> } } } };
            (spec.spec.template.spec.containers[0] as { image: string }).image = image;
            h.cluster.answer(billing("2.0.0", { workload: { stdout: spec as never } }));
            ok(await run("2.1.0", BILLING));
            const set = h.cluster.calls().filter((call) => call.argv[3] === "set").at(-1);
            assert.equal(set?.argv[6], `billing=${expected}`, image);
        }
    });

    test("a container the workload lacks says which setting to fix, and nothing is changed", async () => {
        h.configure(withEnvironment("billing", "staging", { deploy: { method: "kubectl-image", workload: "deployment/billing", container: "api" } }));
        h.cluster.answer(billing("2.0.0"));
        const result = await run("2.1.0", BILLING);
        assert.equal(result.error?.message, 'deployment/billing has no container api (it has billing, mesh-proxy): fix "container" in the ops catalog of jig.json (deploy)');
        assert.deepEqual(h.cluster.calls().filter((call) => call.argv[3] === "set"), []);
    });

    test("an image that could be read as a flag is not one a tag is put on", async () => {
        const spec = workload("billing", { service: "billing", kind: "Deployment" }) as { spec: { template: { spec: { containers: Array<{ name: string; image: string }> } } } };
        (spec.spec.template.spec.containers[0] as { image: string }).image = "--force/billing:2.0.0";
        h.cluster.answer(billing("2.0.0", { workload: { stdout: spec as never } }));
        assert.equal((await run("2.1.0", BILLING)).error?.message, "The image of billing in deployment/billing is not one a deploy can put a tag on");
        assert.deepEqual(h.cluster.calls().filter((call) => call.argv[3] === "set"), []);
    });

    test("a stateful set is deployed the same way", async () => {
        h.configure(withEnvironment("billing", "staging", { deploy: { method: "kubectl-image", workload: "statefulset/ledger", container: "ledger" } }));
        h.cluster.answer(billing("2.0.0", { workload: { stdout: workload("ledger", { service: "ledger", kind: "StatefulSet" }) } }));
        ok(await run("1.5.0", BILLING));
        const set = h.cluster.calls().find((call) => call.argv[3] === "set");
        assert.deepEqual(set?.argv.slice(3), ["set", "image", "statefulset/ledger", "ledger=registry.example.test/shop/ledger:1.5.0"]);
    });
});

describe("what is refused", () => {
    test("a version that could be read as a flag, a second argument or another image is blocked before anything is read", async () => {
        h.cluster.answer(orders("1.4.2"));
        for (const version of ["-f", "--set=image.tag=x", "1.4.3 --force", "1.4.3;rm", "$(id)", "x/y", "x:y", "x@sha256:abc", "..", ".x", "a".repeat(129), ""]) {
            const result = await run(version);
            assert.match(result.blocked ?? "", /^Blocked by jig-core: deploy cannot run with this input: deploy run(: version must be an image tag| needs version)/, JSON.stringify(version));
        }
        assert.deepEqual(h.jig.started, []);
        assert.deepEqual(h.cluster.helmCalls(), []);
    });

    test("production is blocked in classify, and nothing is read or started", async () => {
        h.cluster.answer(orders("1.4.2"));
        const result = await run("1.4.3", { service: "orders-api", environment: "production" });
        assert.equal(result.blocked, "Blocked by jig-core: deploy cannot run with this input: deploy run is refused: orders-api in production is production: the agent never changes production");
        assert.equal(result.cls, undefined);
        assert.deepEqual(h.jig.started, []);
    });

    test("an environment the catalog gives no deploy method is blocked", async () => {
        h.configure(withEnvironment("orders-api", "staging", { deploy: undefined }));
        h.cluster.answer(orders("1.4.2"));
        const result = await run("1.4.3");
        assert.equal(result.blocked, "Blocked by jig-core: deploy cannot run with this input: deploy run is refused: the catalog gives orders-api in staging no deploy method: the agent deploys only where the catalog names one");
        assert.deepEqual(h.jig.started, []);
    });

    test("an environment jig-core counts as production is blocked, whatever it is called", async () => {
        h.jig.setKinds({ staging: "production" });
        const result = await run("1.4.3");
        assert.match(result.blocked ?? "", /^Blocked by jig-core: deploy cannot run with this input: deploy run is refused: orders-api in staging is production: the agent never changes production\. jig-core counts a name it does not know as production: if staging is a test environment, define it under "environments" in jig\.json with kind test$/);
        assert.deepEqual(h.jig.started, []);
    });

    test("a name jig-core has never heard of counts as production, so a deploy there is blocked", async () => {
        const raw = section();
        const orders_ = (raw.services as Record<string, { environments: Record<string, unknown> }>)["orders-api"] as { environments: Record<string, unknown> };
        orders_.environments.preview = orders_.environments.staging;
        h.configure(raw);
        const result = await run("1.4.3", { service: "orders-api", environment: "preview" });
        assert.match(result.blocked ?? "", /orders-api in preview is production/);
        assert.deepEqual(h.jig.started, []);
    });

    test("run without jig-core's check is refused the same way, and starts nothing", async () => {
        h.cluster.answer(orders("1.4.2"));
        await assert.rejects(
            h.deploy.tool.execute("direct", { action: "run", service: "orders-api", environment: "production", version: "1.4.3" } as never, undefined, undefined, {} as never),
            (error: unknown) => error instanceof TypeError && /^deploy run is refused: orders-api in production is production/.test(error.message),
        );
        await assert.rejects(
            h.deploy.tool.execute("direct", { action: "rollback", service: "orders-api", environment: "production" } as never, undefined, undefined, {} as never),
            (error: unknown) => error instanceof TypeError && /^deploy rollback is refused: orders-api in production is production/.test(error.message),
        );
        assert.deepEqual(h.jig.started, []);
    });

    test("an unknown service or environment is blocked with the names there are", async () => {
        const result = await run("1.4.3", { service: "nope", environment: "staging" });
        assert.equal(result.blocked, 'Blocked by jig-core: deploy cannot run with this input: deploy: no service named "nope". Known services: orders-api (staging, production), billing (staging)');
    });
});

describe("when a command fails", () => {
    test("helm exiting with an error is the model's to read, once: the first line of helm's complaint, and no second try", async () => {
        h.cluster.answer(orders("1.4.2", { helmUpgrade: { code: 1, stderr: "Error: UPGRADE FAILED: an error occurred while finding last successful release manifest\nsecond line" } }));
        const result = await run("1.4.3");
        assert.equal(result.error?.message, "helm upgrade failed (exit 1): Error: UPGRADE FAILED: an error occurred while finding last successful release manifest; second line");
        assert.equal(h.cluster.helmCalls().length, 1);
        assert.deepEqual(h.jig.facts.get(result.id), [{ method: "helm", outcome: "failed" }]);
    });

    test("a locked release is told as the user's to look at", async () => {
        h.cluster.answer(orders("1.4.2", { helmUpgrade: { code: 1, stderr: "Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress" } }));
        assert.match((await run("1.4.3")).error?.message ?? "", /^helm says another operation on the release of orders-api in staging is in progress/);
        assert.equal(h.cluster.helmCalls().length, 1);
    });

    test("a sign-in that expired is the user's to fix, and a user who may not change the cluster is told so", async () => {
        h.cluster.answer(orders("1.4.2", { helmUpgrade: { code: 1, stderr: "Error: Kubernetes cluster unreachable: getting credentials: exec: Token has expired" } }));
        assert.match((await run("1.4.3")).error?.message ?? "", /^kubectl is not signed in to context test-cluster/);
        h.cluster.answer(billing("2.0.0", { setImage: { code: 1, stderr: 'Error from server (Forbidden): deployments.apps "billing" is forbidden: User "u" cannot patch resource "deployments"' } }));
        assert.match((await run("2.1.0", BILLING)).error?.message ?? "", /^The kubeconfig user is not allowed to change billing in staging/);
        assert.equal(h.cluster.calls().filter((call) => call.argv[3] === "set").length, 1);
    });

    test("a helm that is not installed is an error, nothing ran, and no deploy is recorded", async () => {
        h.cluster.answer(orders("1.4.2"));
        h.jig.script = (file) => (file === "helm" ? new Error("helm is not installed or not on PATH") : undefined);
        const result = await run("1.4.3");
        assert.equal(result.error?.message, "helm is not installed or not on PATH");
        h.jig.script = undefined;
        assert.match(ok(await h.deploy.call({ action: "status", ...ORDERS })), /^No deploy or rollback was run from here/);
    });

    test("a cluster that cannot be read stops the deploy before anything is changed", async () => {
        h.cluster.answer({ pods: { code: 1, stderr: "Unable to connect to the server: dial tcp: i/o timeout" }, helmUpgrade: { stdout: UPGRADED } });
        const result = await run("1.4.3");
        assert.match(result.error?.message ?? "", /^Cannot reach the cluster of context test-cluster/);
        assert.deepEqual(h.cluster.helmCalls(), []);
    });

    test("a call cancelled before it started starts nothing", async () => {
        h.cluster.answer(orders("1.4.2"));
        const controller = new AbortController();
        controller.abort();
        const result = await run("1.4.3", ORDERS, { signal: controller.signal });
        assert.ok(result.error !== undefined);
        assert.deepEqual(h.cluster.helmCalls(), []);
    });
});

describe("rollback with helm", () => {
    const helmWorld = (more = {}) =>
        orders("1.4.3", {
            helmHistory: history({ revision: 4 }, { revision: 5, status: "deployed" }),
            helmGetValues: values("1.4.2"),
            helmRollback: { stdout: "Rollback was a success! Happy Helming!\n" },
            ...more,
        });

    test("finds the revision before the current one and what it ran, and starts helm rollback for the release", async () => {
        h.cluster.answer(helmWorld());
        const result = await rollback();
        const history_ = ["history", "orders-api", "--kube-context", "test-cluster", "--namespace", "orders-staging", "--max", "2", "-o", "json"];
        const values_ = ["get", "values", "orders-api", "--revision", "4", "--all", "-o", "json", "--kube-context", "test-cluster", "--namespace", "orders-staging"];
        // The preview reads the history and the values, and the run reads them again before it rolls back.
        assert.deepEqual(h.cluster.helmCalls().map((call) => call.argv), [
            history_,
            values_,
            history_,
            values_,
            ["rollback", "orders-api", "--kube-context", "test-cluster", "--namespace", "orders-staging"],
        ]);
        assert.deepEqual(result.cls, { action: "rollback", environment: "staging", effect: "write" });
        assert.equal(
            ok(result),
            [
                "Started the rollback of orders-api in staging with helm to revision 4, which ran 1.4.2 (it was running 1.4.3). Nothing waits for the rollout: deploy watch with version 1.4.2 reports when it ends, or runtime rollout with waitFor.",
                "Rollback was a success! Happy Helming!",
            ].join("\n"),
        );
    });

    test("says so when the revision's version cannot be read, and still goes back", async () => {
        h.cluster.answer(helmWorld({ helmGetValues: values() }));
        const result = await rollback();
        assert.match(ok(result), /^Started the rollback of orders-api in staging with helm to revision 4 \(its version could not be read\) \(it was running 1\.4\.3\)\. Nothing waits for the rollout: runtime rollout shows how it goes\./);
    });

    test("reads a numeric image tag as the text it is", async () => {
        h.cluster.answer(helmWorld({ helmGetValues: values(7) }));
        assert.match(ok(await rollback()), /to revision 4, which ran 7 /);
    });

    test("a release with one revision has nothing to go back to", async () => {
        h.cluster.answer(helmWorld({ helmHistory: history({ revision: 1, status: "deployed" }) }));
        const result = await rollback();
        assert.equal(result.error?.message, "The Helm release orders-api has one revision, so there is nothing to go back to");
        assert.equal(h.cluster.helmCalls().filter((call) => call.argv[0] === "rollback").length, 0);
    });

    test("a release helm does not know says which setting to check", async () => {
        h.cluster.answer(helmWorld({ helmHistory: { code: 1, stderr: "Error: release: not found" } }));
        assert.match((await rollback()).error?.message ?? "", /^helm has no such release for orders-api in staging/);
    });

    test("helm failing to roll back is told, and not tried again", async () => {
        h.cluster.answer(helmWorld({ helmRollback: { code: 1, stderr: "Error: rollback failed: another operation (install/upgrade/rollback) is in progress" } }));
        const result = await rollback();
        assert.match(result.error?.message ?? "", /^helm says another operation on the release/);
        assert.equal(h.cluster.helmCalls().filter((call) => call.argv[0] === "rollback").length, 1);
    });
});

describe("rollback with kubectl rollout undo", () => {
    const deployments = (more = {}) =>
        billing("2.1.0", {
            replicasets: list(
                replicaSet("billing-a1", { service: "billing", owner: "billing", revision: 2, tag: "1.9.0" }),
                replicaSet("billing-b2", { service: "billing", owner: "billing", revision: 3, tag: "2.0.0" }),
                replicaSet("billing-c3", { service: "billing", owner: "billing", revision: 4, tag: "2.1.0" }),
                replicaSet("other-d4", { service: "billing", owner: "other", revision: 9, tag: "9.9.9" }),
            ),
            rolloutUndo: { stdout: "deployment.apps/billing rolled back\n" },
            ...more,
        });

    test("goes back to the second newest revision of the deployment, as kubectl does, and says what it ran", async () => {
        h.cluster.answer(deployments());
        const result = await rollback(BILLING);
        const undos = h.cluster.calls().filter((call) => call.argv[3] === "rollout");
        assert.deepEqual(undos.map((call) => call.argv), [["--request-timeout=50s", "--context=test-cluster", "--namespace=billing-staging", "rollout", "undo", "deployment/billing"]]);
        assert.equal(
            ok(result),
            [
                "Started the rollback of billing in staging with kubectl-image to revision 3, which ran 2.0.0 (it was running 2.1.0). Nothing waits for the rollout: deploy watch with version 2.0.0 reports when it ends, or runtime rollout with waitFor.",
                "deployment.apps/billing rolled back",
            ].join("\n"),
        );
    });

    test("reads the replica sets of this deployment and no other", async () => {
        h.cluster.answer(deployments({ replicasets: list(replicaSet("other-d4", { service: "billing", owner: "other", revision: 9, tag: "9.9.9" })) }));
        assert.equal((await rollback(BILLING)).error?.message, "deployment/billing has no earlier revision to go back to (or it does not exist)");
        assert.deepEqual(h.cluster.calls().filter((call) => call.argv[3] === "rollout"), []);
    });

    test("a stateful set goes back through its controller revisions", async () => {
        h.configure(withEnvironment("billing", "staging", { deploy: { method: "kubectl-image", workload: "statefulset/ledger", container: "ledger" } }));
        h.cluster.answer(
            billing("2.1.0", {
                controllerrevisions: list(
                    controllerRevision("ledger-1", { revision: 1, tag: "1.0.0" }),
                    controllerRevision("ledger-2", { revision: 2, tag: "1.1.0" }),
                    controllerRevision("ledger-3", { revision: 3, tag: "1.2.0" }),
                ),
                rolloutUndo: { stdout: "statefulset.apps/ledger rolled back\n" },
            }),
        );
        const result = await rollback(BILLING);
        assert.match(ok(result), /to revision 2, which ran 1\.1\.0 \(it was running 2\.1\.0\)/);
        assert.deepEqual(h.cluster.calls().find((call) => call.argv[3] === "rollout")?.argv.slice(3), ["rollout", "undo", "statefulset/ledger"]);
    });

    test("kubectl failing to roll back is told, and not tried again", async () => {
        h.cluster.answer(deployments({ rolloutUndo: { code: 1, stderr: 'error: you cannot rollback a paused deployment; resume it first with "kubectl rollout resume deployment/billing" and try again' } }));
        const result = await rollback(BILLING);
        assert.match(result.error?.message ?? "", /^kubectl rollout failed \(exit 1\): error: you cannot rollback a paused deployment/);
        assert.equal(h.cluster.calls().filter((call) => call.argv[3] === "rollout").length, 1);
    });
});

describe("rollback is for test environments only", () => {
    test("production is blocked, as for a deploy", async () => {
        const result = await rollback({ service: "orders-api", environment: "production" });
        assert.equal(result.blocked, "Blocked by jig-core: deploy cannot run with this input: deploy rollback is refused: orders-api in production is production: the agent never changes production");
        assert.deepEqual(h.jig.started, []);
    });

    test("an environment that is not a test one is blocked, though a deploy there is not: this machine, and outside services", async () => {
        h.cluster.answer(orders("1.4.3", { helmHistory: history({ revision: 4 }, { revision: 5 }), helmGetValues: values("1.4.2"), helmRollback: { stdout: "ok\n" } }));
        for (const kind of ["local", "external"] as const) {
            h.jig.setKinds({ staging: kind });
            const blocked = await rollback();
            assert.equal(blocked.blocked, `Blocked by jig-core: deploy cannot run with this input: deploy rollback is refused: a rollback works in test environments only, and staging is ${kind} for jig-core`, kind);
            const deployed = await run("1.4.3");
            assert.equal(deployed.blocked, undefined, `a deploy to a ${kind} environment is not refused by the tool`);
        }
        assert.equal(h.cluster.helmCalls().filter((call) => call.argv[0] === "rollback").length, 0);
    });

    test("an environment without a deploy method is blocked", async () => {
        h.configure(withEnvironment("orders-api", "staging", { deploy: undefined }));
        const result = await rollback();
        assert.match(result.blocked ?? "", /deploy rollback is refused: the catalog gives orders-api in staging no deploy method/);
        assert.deepEqual(h.jig.started, []);
    });
});

describe("what kubectl is asked", () => {
    test("a deploy and a rollback start kubectl with nothing but get, set image or rollout undo", async () => {
        h.cluster.answer(billing("2.0.0", { replicasets: list(replicaSet("billing-a1", { service: "billing", owner: "billing", revision: 1 }), replicaSet("billing-b2", { service: "billing", owner: "billing", revision: 2 })), rolloutUndo: { stdout: "ok\n" } }));
        ok(await run("2.1.0", BILLING));
        ok(await rollback(BILLING));
        for (const call of h.cluster.calls()) assert.ok(["get", "set", "rollout"].includes(call.argv[3] ?? ""), call.argv.join(" "));
    });
});
