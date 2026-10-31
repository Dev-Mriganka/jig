// jig-ops against a real Kubernetes cluster (kind) and Helm. A tiny chart, an unprivileged nginx, is deployed, changed, rolled
// back and broken on purpose through the `deploy` tool, and the `runtime` tool reads what the cluster shows. `kubectl set image` and
// `kubectl rollout undo` run against a plain deployment. The test's own kubectl and helm only set up the namespace and look at
// what the tool did. The tests run in order, each from what the one before left in the cluster.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { describeIt, must } from "../../../../test/support/it.ts";
import { ok } from "../support/harness.ts";
import type { Harness } from "../support/harness.ts";
import { realHarness, run, sleep, untilDone } from "../support/real.ts";
import type { Raw } from "../support/section.ts";

const CHART = path.join(path.dirname(fileURLToPath(import.meta.url)), "chart");
const RELEASE = "jigit-web";
const SELECTOR = `app.kubernetes.io/name=${RELEASE}`;
const OLD = "1.30.5-alpine";
const NEW = "1.30.6-alpine";
const IMAGE = "nginxinc/nginx-unprivileged";
const OLD_DIGEST = "sha256:56b8272e43a0525f67aed68d1e0794a712d10e3e45a563e118e9a77c817e6f86";
const NEW_DIGEST = "sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03";
const BAD = "0.0.1-does-not-exist";
const LONG = { timeout: 360_000 };

describeIt(
    "jig-ops deploy and runtime against Kubernetes and Helm",
    {
        service: "kubernetes",
        variables: ["JIG_IT_KUBE_CONTEXT"],
        hint: "a kind cluster whose kubectl context is in JIG_IT_KUBE_CONTEXT, with kubectl and helm on PATH",
    },
    () => {
        const context = () => must("JIG_IT_KUBE_CONTEXT");
        const namespace = `jigit-${randomBytes(3).toString("hex")}`;
        const kubectl = (...args: string[]) =>
            run("kubectl", [`--context=${context()}`, `--namespace=${namespace}`, ...args]);
        const helm = (...args: string[]) =>
            run("helm", [...args, "--kube-context", context(), "--namespace", namespace]);
        const web = { service: "web", environment: "staging" };
        const plain = { service: "plain", environment: "staging" };

        const section = (): Raw => ({
            services: {
                web: {
                    environments: {
                        staging: {
                            deploy: { method: "helm", release: RELEASE, chart: CHART },
                            runtime: {
                                kubernetes: {
                                    context: context(),
                                    namespace,
                                    selector: SELECTOR,
                                    container: "web",
                                    port: 8080,
                                    healthPath: "/",
                                },
                            },
                        },
                        // The same cluster, as production: it is read, never deployed to, and no command runs in a pod.
                        production: { runtime: { kubernetes: { context: context(), namespace, selector: SELECTOR } } },
                        // A context nobody has.
                        lost: {
                            runtime: { kubernetes: { context: "no-such-context", namespace, selector: SELECTOR } },
                        },
                        // A release that was never installed, and a chart that is not there.
                        fresh: {
                            deploy: { method: "helm", release: "jigit-fresh", chart: CHART },
                            runtime: {
                                kubernetes: {
                                    context: context(),
                                    namespace,
                                    selector: "app.kubernetes.io/name=jigit-fresh",
                                },
                            },
                        },
                        nochart: {
                            deploy: {
                                method: "helm",
                                release: "jigit-nochart",
                                chart: path.join(CHART, "not-a-chart"),
                            },
                            runtime: {
                                kubernetes: {
                                    context: context(),
                                    namespace,
                                    selector: "app.kubernetes.io/name=jigit-nochart",
                                },
                            },
                        },
                    },
                },
                plain: {
                    environments: {
                        staging: {
                            deploy: { method: "kubectl-image", workload: "deployment/jigit-plain", container: "web" },
                            runtime: { kubernetes: { context: context(), namespace, selector: "app=jigit-plain" } },
                        },
                    },
                },
            },
        });

        const harness = (t: TestContext): Harness => {
            const h = realHarness(t, section());
            h.jig.setKinds({ lost: "test", fresh: "test", nochart: "test" });
            return h;
        };

        /** Starts a rollout watch for a version and returns how it ended. */
        async function watched(h: Harness, version: string, target: Record<string, string> = web) {
            const said = ok(await h.deploy.call({ action: "watch", ...target, version, timeoutMinutes: 6 }));
            // A watch that is already open for the same rollout is returned, not started twice.
            const id = /as (watch-\d+)\./.exec(said)?.[1];
            assert.ok(id, said);
            const done = await untilDone(h, id);
            h.jig.api.watches.stop(id);
            return done;
        }

        /** The images of the chart's pods, one per pod. */
        const images = (): string[] =>
            kubectl(
                "get",
                "pods",
                "-l",
                SELECTOR,
                "-o",
                "jsonpath={range .items[*]}{.spec.containers[0].image}{'\\n'}{end}",
            )
                .split("\n")
                .filter(Boolean);
        const deployed = (): string =>
            kubectl("get", "deployment", RELEASE, "-o", "jsonpath={.spec.template.spec.containers[0].image}");
        const revisions = (): Array<{ revision: number; status: string }> =>
            JSON.parse(helm("history", RELEASE, "-o", "json"));

        before(() => {
            const versions = JSON.parse(run("kubectl", [`--context=${context()}`, "version", "-o", "json"]));
            console.log(
                `Kubernetes ${versions.serverVersion?.gitVersion} (kubectl ${versions.clientVersion?.gitVersion}), ${run("helm", ["version", "--short"]).trim()}`,
            );
            run("kubectl", [`--context=${context()}`, "create", "namespace", namespace]);
            // A plain deployment for `kubectl set image`, with its image pinned by tag and digest as the chart's is.
            run(
                "kubectl",
                [`--context=${context()}`, `--namespace=${namespace}`, "apply", "-f", "-"],
                [
                    "apiVersion: apps/v1",
                    "kind: Deployment",
                    "metadata: { name: jigit-plain, labels: { app: jigit-plain } }",
                    "spec:",
                    "  replicas: 1",
                    "  selector: { matchLabels: { app: jigit-plain } }",
                    "  template:",
                    "    metadata: { labels: { app: jigit-plain } }",
                    "    spec:",
                    "      securityContext: { runAsNonRoot: true }",
                    "      containers:",
                    "        - name: web",
                    `          image: ${IMAGE}:${OLD}@${OLD_DIGEST}`,
                    "          ports: [{ containerPort: 8080 }]",
                    "          readinessProbe: { httpGet: { path: /, port: 8080 }, periodSeconds: 2 }",
                    "",
                ].join("\n"),
            );
        });

        after(() => {
            try {
                run("kubectl", [`--context=${context()}`, "delete", "namespace", namespace, "--wait=false"]);
            } catch (error) {
                console.log(`the namespace ${namespace} was not removed: ${(error as Error).message}`);
            }
        });

        test("before any deploy there are no pods, and the plan says nothing runs and what the command will be", async (t) => {
            const h = harness(t);
            assert.match(
                ok(await h.runtime.call({ action: "pods", ...web })),
                new RegExp(
                    `^No pods match ${SELECTOR.replace(/[./=]/g, "\\$&")} for web in staging \\(namespace ${namespace}\\)\\.$`,
                ),
            );
            const plan = await h.deploy.call({ action: "plan", ...web, version: OLD });
            const text = ok(plan);
            assert.match(
                text,
                /^Deploy plan for web in staging \(test\): method helm\.\nRunning now: none \(no pods are running\)\nRequested: {3}1\.30\.5-alpine\n/,
            );
            assert.ok(
                text.includes(
                    `Command:     helm upgrade --install ${RELEASE} ${CHART} --kube-context ${context()} --namespace ${namespace} --set image.tag=${OLD} --wait=false`,
                ),
                text,
            );
            assert.deepEqual(plan.cls, { action: "plan", environment: "staging", effect: "read" });
        });

        test(
            "deploy run asks with the exact command, installs the release once, and the watch ends passed",
            LONG,
            async (t) => {
                const h = harness(t);
                const result = await h.deploy.call({ action: "run", ...web, version: OLD });
                const text = ok(result);
                assert.deepEqual(result.cls, { action: "run", environment: "staging", effect: "write" });
                assert.match(result.preview?.body ?? "", new RegExp(`Command: +helm upgrade --install ${RELEASE} `));
                assert.match(result.preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);
                assert.match(text, /^Started the deploy of 1\.30\.5-alpine to web in staging with helm /);
                assert.match(text, /Nothing waits for the rollout/);
                assert.match(text, /Release "jigit-web" does not exist\. Installing it now\.|STATUS: deployed/);
                const releases = JSON.parse(helm("list", "-o", "json"));
                assert.equal(releases.length, 1);
                assert.equal(releases[0].name, RELEASE);
                assert.equal(releases[0].status, "deployed");
                assert.equal(deployed(), `${IMAGE}:${OLD}@${OLD_DIGEST}`);

                const done = await watched(h, OLD);
                assert.equal(done.outcome, "passed", done.summary);
                assert.match(done.summary, /^web in staging: Running: 2 of 2 pods ready on 1\.30\.5-alpine\./);
            },
        );

        test(
            "runtime reads the pods, the rollout, the logs, the events and the health of what runs",
            LONG,
            async (t) => {
                const h = harness(t);
                const pods = ok(await h.runtime.call({ action: "pods", ...web }));
                const lines = pods.split("\n");
                assert.equal(lines[0], `2 pods of web in staging (namespace ${namespace}):`);
                const names: string[] = [];
                for (const line of lines.slice(1)) {
                    const found =
                        /^- (jigit-web-[a-z0-9]+-[a-z0-9]+): 1\/1 ready, Running, 0 restarts, \S+, image 1\.30\.5-alpine$/.exec(
                            line,
                        );
                    assert.ok(found, line);
                    names.push(found[1] as string);
                }
                assert.equal(names.length, 2);

                const rollout = ok(await h.runtime.call({ action: "rollout", ...web }));
                assert.match(
                    rollout,
                    new RegExp(
                        `^web in staging \\(namespace ${namespace}\\): Running: 2 of 2 pods ready on 1\\.30\\.5-alpine\\.`,
                    ),
                );
                assert.match(rollout, /\nWorkload: Deployment jigit-web, 2\/2 ready/);
                const waited = ok(await h.runtime.call({ action: "rollout", ...web, waitFor: OLD, timeoutSec: 30 }));
                assert.match(waited, /: Running: 2 of 2 pods ready on 1\.30\.5-alpine\./);

                const logs = ok(await h.runtime.call({ action: "logs", ...web, pod: names[0], tail: 50 }));
                assert.match(logs, new RegExp(`^${names[0]} \\(container web\\): \\d+ lines? \\(tail 50\\)\\n`));
                assert.match(logs, /nginx\/1\.30/);
                const defaulted = ok(await h.runtime.call({ action: "logs", ...web }));
                assert.match(defaulted, /^jigit-web-\S+ \(container web\): \d+ lines? \(tail 200\)/);
                const previous = await h.runtime.call({ action: "logs", ...web, pod: names[0], previous: true });
                assert.equal(
                    previous.error?.message,
                    "The pod has no previous container log: its container has not restarted",
                );

                const events = ok(await h.runtime.call({ action: "events", ...web }));
                assert.match(
                    events,
                    new RegExp(`^\\d+ events? about web in staging \\(namespace ${namespace}\\), oldest first`),
                );
                assert.match(events, /(Scheduled|Pulled|Created|Started) Pod\/jigit-web-/);

                // curl in the pod: the catalog names the path, the port and the container.
                const health = ok(await h.runtime.call({ action: "health", ...web }));
                assert.match(health, /HTTP 200/);
                assert.match(health, /Welcome to nginx!/);
            },
        );

        test("production is read, never deployed to, and no command runs in its pods", async (t) => {
            const h = harness(t);
            assert.match(
                ok(await h.runtime.call({ action: "pods", service: "web", environment: "production" })),
                /^2 pods of web in production/,
            );
            const deploy = await h.deploy.call({
                action: "run",
                service: "web",
                environment: "production",
                version: NEW,
            });
            assert.ok(
                deploy.blocked !== undefined && /production/i.test(deploy.blocked),
                JSON.stringify(deploy.blocked),
            );
            const health = await h.runtime.call({ action: "health", service: "web", environment: "production" });
            assert.ok(health.blocked !== undefined, "no curl in a pod of production");
            const plan = ok(
                await h.deploy.call({ action: "plan", service: "web", environment: "production", version: NEW }),
            );
            assert.match(plan, /production/);
        });

        test(
            "a deploy of a new version goes on although a pod was replaced while the person read the preview: that is not a change of version",
            LONG,
            async (t) => {
                const h = harness(t);
                const result = await h.deploy.call(
                    { action: "run", ...web, version: NEW },
                    {
                        // A pod goes and another takes its place: the pods change, the versions that run do not.
                        between: async () => {
                            const first = kubectl(
                                "get",
                                "pods",
                                "-l",
                                SELECTOR,
                                "-o",
                                "jsonpath={.items[0].metadata.name}",
                            );
                            kubectl("delete", "pod", first.trim(), "--wait=false");
                        },
                    },
                );
                assert.match(
                    ok(result),
                    /^Started the deploy of 1\.30\.6-alpine to web in staging with helm \(it was running 1\.30\.5-alpine\)/,
                );
                const done = await watched(h, NEW);
                assert.equal(done.outcome, "passed", done.summary);
                assert.match(done.summary, /: Running: \d of \d pods ready on 1\.30\.6-alpine\./);
                assert.equal(deployed(), `${IMAGE}:${NEW}@${NEW_DIGEST}`);
                const status = ok(await h.deploy.call({ action: "status", ...web })).split("\n");
                assert.match(
                    status[0] ?? "",
                    /^Last run from here: the deploy of 1\.30\.6-alpine with helm, \d+s ago, while 1\.30\.5-alpine was running: started\.$/,
                );
                assert.match(status[1] ?? "", /: Running: \d of \d pods ready on 1\.30\.6-alpine\.$/);
            },
        );

        test("a rollback goes back one revision, to the version that revision ran", LONG, async (t) => {
            const h = harness(t);
            const result = await h.deploy.call({ action: "rollback", ...web });
            assert.match(result.preview?.body ?? "", /Going back to: +revision 1, which ran 1\.30\.5-alpine/);
            assert.match(
                ok(result),
                /^Started the rollback of web in staging with helm to revision 1, which ran 1\.30\.5-alpine \(it was running 1\.30\.6-alpine\)\./,
            );
            const done = await watched(h, OLD);
            assert.equal(done.outcome, "passed", done.summary);
            assert.equal(deployed(), `${IMAGE}:${OLD}@${OLD_DIGEST}`);
            assert.deepEqual(
                revisions().map((entry) => entry.revision),
                [1, 2, 3],
            );
            assert.equal(revisions().at(-1)?.status, "deployed");
        });

        test(
            "a deploy whose running versions changed while the person read the preview is refused, and nothing is run",
            LONG,
            async (t) => {
                const h = harness(t);
                const before = revisions().length;
                const result = await h.deploy.call(
                    { action: "run", ...web, version: NEW },
                    {
                        between: async () => {
                            // Someone else deploys, and the cluster starts pods of the new version.
                            helm(
                                "upgrade",
                                RELEASE,
                                CHART,
                                "--reuse-values",
                                "--set",
                                `image.tag=${NEW}`,
                                "--wait=false",
                            );
                            for (
                                let attempt = 0;
                                attempt < 60 && !images().some((image) => image.includes(NEW));
                                attempt++
                            ) {
                                await sleep(500);
                            }
                        },
                    },
                );
                assert.match(result.error?.message ?? "", /changed since the preview/);
                assert.equal(revisions().length, before + 1, "only the other deploy ran");
                const done = await watched(h, NEW);
                assert.equal(done.outcome, "passed", done.summary);
                const waited = ok(await h.runtime.call({ action: "rollout", ...web, waitFor: NEW, timeoutSec: 60 }));
                assert.match(waited, /: Running: \d of \d pods ready on 1\.30\.6-alpine\./);
            },
        );

        test(
            "a version that does not exist ends the watch failed, the rollout is Failing, the events say why, and a rollback recovers",
            LONG,
            async (t) => {
                const h = harness(t);
                const started = await h.deploy.call({ action: "run", ...web, version: BAD });
                assert.match(ok(started), /^Started the deploy of 0\.0\.1-does-not-exist to web in staging with helm /);
                const done = await watched(h, BAD);
                assert.equal(done.outcome, "failed", done.summary);
                assert.match(done.summary, /Failing/);
                assert.match(done.summary, /ImagePullBackOff|ErrImagePull/);

                const rollout = ok(await h.runtime.call({ action: "rollout", ...web }));
                assert.match(rollout, /: Failing: pod jigit-web-\S+ is (ErrImagePull|ImagePullBackOff)/);
                const events = ok(await h.runtime.call({ action: "events", ...web }));
                assert.match(events, /Warning (Failed|BackOff)/);

                const back = await h.deploy.call({ action: "rollback", ...web });
                assert.match(
                    ok(back),
                    /^Started the rollback of web in staging with helm to revision 4, which ran 1\.30\.6-alpine /,
                );
                // The pod that cannot start goes when its replica set is scaled down; a watch that began before would still see it.
                for (let attempt = 0; attempt < 120 && images().some((image) => image.includes(BAD)); attempt++)
                    await sleep(1000);
                const recovered = await watched(h, NEW);
                assert.equal(recovered.outcome, "passed", recovered.summary);
            },
        );

        test(
            "kubectl set image changes only the tag of a plain deployment, and rollout undo goes back to the pinned image",
            LONG,
            async (t) => {
                const h = harness(t);
                const first = await watched(h, OLD, plain);
                assert.equal(first.outcome, "passed", first.summary);
                const plan = ok(await h.deploy.call({ action: "plan", ...plain, version: NEW }));
                assert.match(
                    plan,
                    /^Deploy plan for plain in staging \(test\): method kubectl-image\.\nRunning now: 1\.30\.5-alpine\nRequested: {3}1\.30\.6-alpine\n/,
                );
                assert.ok(plan.includes(`set image deployment/jigit-plain web=${IMAGE}:${NEW}`), plan);

                const result = await h.deploy.call({ action: "run", ...plain, version: NEW });
                assert.match(
                    ok(result),
                    /^Started the deploy of 1\.30\.6-alpine to plain in staging with kubectl-image /,
                );
                const image = kubectl(
                    "get",
                    "deployment",
                    "jigit-plain",
                    "-o",
                    "jsonpath={.spec.template.spec.containers[0].image}",
                );
                assert.equal(
                    image,
                    `${IMAGE}:${NEW}`,
                    "only the tag was set: the digest was taken off with the old tag",
                );
                const done = await watched(h, NEW, plain);
                assert.equal(done.outcome, "passed", done.summary);

                const back = await h.deploy.call({ action: "rollback", ...plain });
                assert.match(back.preview?.body ?? "", /1\.30\.5-alpine/);
                ok(back);
                const undone = await watched(h, OLD, plain);
                assert.equal(undone.outcome, "passed", undone.summary);
                assert.equal(
                    kubectl(
                        "get",
                        "deployment",
                        "jigit-plain",
                        "-o",
                        "jsonpath={.spec.template.spec.containers[0].image}",
                    ),
                    `${IMAGE}:${OLD}@${OLD_DIGEST}`,
                );
            },
        );

        test("what kubectl and helm say when something is wrong comes out as one line that says whose it is to fix", async (t) => {
            const h = harness(t);
            const lost = await h.runtime.call({ action: "pods", service: "web", environment: "lost" });
            assert.match(
                lost.error?.message ?? "",
                /^kubectl has no context no-such-context \(web in lost\): fix "context" in the ops catalog/,
            );
            // helm has no such release to go back in.
            const rollback = await h.deploy.call({ action: "rollback", service: "web", environment: "fresh" });
            const said = rollback.error?.message ?? rollback.blocked ?? rollback.preview?.summary ?? "";
            assert.match(said, /no such release|not found|nothing to go back to/i);
            const chart = await h.deploy.call({ action: "run", service: "web", environment: "nochart", version: NEW });
            assert.match(chart.error?.message ?? "", /chart|path/i);
            assert.equal(helm("list", "-o", "json").includes("jigit-nochart"), false, "nothing was installed");
        });
    },
);
