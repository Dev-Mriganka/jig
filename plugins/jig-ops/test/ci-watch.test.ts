// The GitLab and Jenkins probes of the ops-ci watch kind, polled the way jig-core's engine polls it, against the fake servers: a
// pipeline or build that finished, and the jobs or stages that must pass. The GitHub half has its tests in
// ci-github-watch.test.ts.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { describe, test } from "node:test";
import type { PollOutcome } from "../../jig-core/src/contract.ts";
import { describeSpec } from "../src/ci/watch.ts";
import type { CiSpec } from "../src/ci/watch.ts";
import type { GitlabSpec, PlainState } from "../src/ci/gitlab-watch.ts";
import type { JenkinsSpec } from "../src/ci/jenkins-watch.ts";
import { ciWorld } from "./support/ci-world.ts";
import type { CiWorld } from "./support/ci-world.ts";
import {
    gitlabResponder,
    gitlabWorld,
    job,
    pipeline,
    SHA,
    SHA2,
    TOKEN as GITLAB_TOKEN,
} from "./support/fake-gitlab.ts";
import type { GitlabWorld } from "./support/fake-gitlab.ts";
import { build, jenkinsResponder, jenkinsWorld, TOKEN as JENKINS_TOKEN } from "./support/fake-jenkins.ts";
import type { JenkinsWorld } from "./support/fake-jenkins.ts";
import { gitlabCi, jenkinsCi, section } from "./support/section.ts";
import type { Raw } from "./support/section.ts";

const SINCE = Date.parse("2026-10-30T10:00:00Z");

type Outcome = PollOutcome<PlainState>;

/** What was published as "artifact ready"; the end of a watch also publishes `jig-ops:ci-finished`, tested in ci-finished.test.ts. */
const artifactEvents = (g: CiWorld) => g.h.bus.emitted.filter((entry) => entry.event === "jig-ops:artifact-ready");

async function poll(g: CiWorld, spec: CiSpec, state?: PlainState): Promise<Outcome> {
    g.h.jig.publish();
    const kind = g.h.jig.kinds.get("ops-ci") as unknown as {
        poll(s: unknown, st: unknown, signal: AbortSignal): Promise<unknown>;
    };
    return (await kind.poll(spec, state, new AbortController().signal)) as Outcome;
}

// ---- GitLab -------------------------------------------------------------------------------------------------------

async function gitlab(t: TestContext, world: GitlabWorld, more: { ci?: Raw; ops?: Raw } = {}): Promise<CiWorld> {
    return ciWorld(t, {
        ci: more.ci ?? gitlabCi(),
        ...(more.ops === undefined ? {} : { ops: more.ops }),
        responder: gitlabResponder(world),
        secrets: { "env:GITLAB_TOKEN": GITLAB_TOKEN },
    });
}

const glSpec = (more: Partial<GitlabSpec> = {}): GitlabSpec => ({
    system: "gitlab",
    service: "orders-api",
    ref: "main",
    sha: SHA,
    finish: { kind: "pipeline" },
    since: SINCE,
    ...more,
});

describe("GitLab: the pipeline finished", () => {
    test("is pending while it runs, and waits as long as the settings say", async (t) => {
        const world = gitlabWorld({
            pipelines: [pipeline(8, "running")],
            jobs: { 8: [job(80, "build", "success"), job(81, "unit", "running")] },
        });
        const g = await gitlab(t, world, { ops: { watch: { pollSeconds: 45 } } });
        const first = await poll(g, glSpec());
        assert.equal(first.done, undefined);
        assert.equal(first.nextPollMs, 45_000);
        assert.deepEqual(first.state, { polls: 1, found: 8 });
        assert.equal(g.requests[0]?.query.get("sha"), SHA, "found by the commit it ran for");
    });

    test("passes when the pipeline succeeds, with the counts, the commit and the link; later polls ask for it by id", async (t) => {
        const world = gitlabWorld({
            pipelines: [pipeline(8, "running")],
            jobs: { 8: [job(80, "build", "success"), job(81, "unit", "running")] },
        });
        const g = await gitlab(t, world);
        const first = await poll(g, glSpec());
        world.pipelines[0]!.status = "success";
        world.jobs[8]![1]!.status = "success";
        const before = g.requests.length;
        const second = await poll(g, glSpec(), first.state);
        assert.equal(second.done?.outcome, "passed");
        assert.equal(
            second.done?.summary,
            "Pipeline passed for pipeline #8 (main at aaaaaaa): 2 pass, 0 fail, 0 pending, 0 skipped",
        );
        assert.deepEqual(second.done?.facts, { pass: 2, fail: 0, pending: 0, skipped: 0, conclusion: "success" });
        assert.deepEqual(second.done?.links, ["https://ci.example.test/acme/orders-api/-/pipelines/8"]);
        assert.equal(g.requests[before]?.path.endsWith("/pipelines/8"), true, "by id, not by listing");
        assert.deepEqual(JSON.parse(JSON.stringify(second.state)), second.state, "the state is plain JSON");
    });

    test("fails at the first failed job, without waiting for the rest, with the lines around the error in its log", async (t) => {
        const world = gitlabWorld({
            pipelines: [pipeline(8, "running")],
            jobs: { 8: [job(80, "build", "success"), job(81, "unit", "failed"), job(82, "slow", "running")] },
            traces: { 81: ["setup", "\u001b[31mFAIL src/a.test.ts\u001b[0m", "Error: boom", "cleanup"].join("\n") },
        });
        const g = await gitlab(t, world);
        const { done } = await poll(g, glSpec());
        assert.equal(done?.outcome, "failed");
        assert.equal(done?.summary, "Job unit failed in pipeline #8 (main at aaaaaaa)");
        assert.equal(done?.details, "unit:\nsetup\nFAIL src/a.test.ts\nError: boom\ncleanup");
        assert.deepEqual(done?.links, ["https://ci.example.test/acme/orders-api/-/jobs/81"]);
        assert.equal(done?.facts?.fail, 1);
    });

    test("a job that may fail does not fail the pipeline", async (t) => {
        const world = gitlabWorld({
            pipelines: [pipeline(8, "success")],
            jobs: { 8: [job(80, "build", "success"), job(81, "lint", "failed", { allow_failure: true })] },
        });
        const g = await gitlab(t, world);
        const { done } = await poll(g, glSpec());
        assert.equal(done?.outcome, "passed");
        assert.match(done?.summary ?? "", /2 pass, 0 fail/);
    });

    test("a pipeline that ends cancelled or skipped is a failure; one that waits for a manual job has passed, and says so", async (t) => {
        const world = gitlabWorld({
            pipelines: [pipeline(8, "canceled")],
            jobs: { 8: [job(80, "build", "canceled")] },
        });
        world.jobs[8] = [];
        const g = await gitlab(t, world);
        assert.equal((await poll(g, glSpec())).done?.summary, "pipeline #8 (main at aaaaaaa) ended as canceled");
        world.pipelines[0]!.status = "skipped";
        assert.equal((await poll(g, glSpec())).done?.outcome, "failed");
        world.pipelines[0]!.status = "manual";
        world.jobs[8] = [job(80, "build", "success"), job(81, "deploy", "manual")];
        const manual = (await poll(g, glSpec())).done;
        assert.equal(manual?.outcome, "passed");
        assert.match(
            manual?.summary ?? "",
            /1 pass, 0 fail, 1 pending, 0 skipped; it waits for a person to start a manual job$/,
        );
    });

    test("a pipeline not yet created is waited for; by commit it is the newest for that commit; by branch it must be new", async (t) => {
        const world = gitlabWorld({ pipelines: [pipeline(5, "success", { sha: SHA2 })] });
        const g = await gitlab(t, world);
        const waiting = await poll(g, glSpec());
        assert.equal(waiting.done, undefined);
        assert.deepEqual(waiting.state, { polls: 1 });
        world.pipelines.push(pipeline(6, "success", { sha: SHA }));
        world.jobs[6] = [job(60, "build", "success")];
        assert.equal((await poll(g, glSpec(), waiting.state)).done?.outcome, "passed");

        const byBranch = glSpec({ sha: undefined, ref: "main" });
        delete byBranch.sha;
        world.pipelines = [pipeline(5, "success", { created_at: "2026-10-30T08:00:00.000Z" })];
        world.jobs[5] = [job(50, "build", "success")];
        assert.equal((await poll(g, byBranch)).done, undefined, "a pipeline from before the watch is not the one");
        world.pipelines.push(pipeline(6, "success", { created_at: "2026-10-30T10:00:20.000Z" }));
        world.jobs[6] = [job(60, "build", "success")];
        assert.match((await poll(g, byBranch)).done?.summary ?? "", /^Pipeline passed for pipeline #6/);
    });

    test("a pipeline named by its id is followed whatever the commit", async (t) => {
        const world = gitlabWorld({ pipelines: [pipeline(8, "success")], jobs: { 8: [job(80, "build", "success")] } });
        const g = await gitlab(t, world);
        const done = (await poll(g, glSpec({ pipelineId: 8, sha: undefined, ref: undefined }))).done;
        assert.equal(done?.outcome, "passed");
        assert.equal(g.requests[0]?.path.endsWith("/pipelines/8"), true);
    });
});

describe("GitLab: the jobs that must pass", () => {
    const jobs = (names: string[]) => glSpec({ finish: { kind: "jobs", names } });

    test("pass when those jobs pass, whatever the rest of the pipeline is still doing", async (t) => {
        const world = gitlabWorld({
            pipelines: [pipeline(8, "running")],
            jobs: { 8: [job(80, "build", "success"), job(81, "unit", "success"), job(82, "e2e", "running")] },
        });
        const g = await gitlab(t, world);
        const { done } = await poll(g, jobs(["build", "unit"]));
        assert.equal(done?.outcome, "passed");
        assert.equal(
            done?.summary,
            "Required jobs passed for pipeline #8 (main at aaaaaaa): 2 pass, 0 fail, 0 pending, 0 skipped",
        );
        assert.equal(done?.facts?.pass, 2);
    });

    test("wait while one has not been reported yet or is still running; a failure elsewhere does not end the watch", async (t) => {
        const world = gitlabWorld({
            pipelines: [pipeline(8, "running")],
            jobs: { 8: [job(80, "build", "success"), job(82, "lint", "failed")] },
        });
        const g = await gitlab(t, world);
        assert.equal((await poll(g, jobs(["build", "unit"]))).done, undefined, "unit has not been reported");
        world.jobs[8]!.push(job(81, "unit", "running"));
        assert.equal((await poll(g, jobs(["build", "unit"]))).done, undefined);
    });

    test("fail at the first of them that fails, with its log; a skipped one will never run", async (t) => {
        const world = gitlabWorld({
            pipelines: [pipeline(8, "running")],
            jobs: { 8: [job(80, "build", "success"), job(81, "unit", "failed")] },
            traces: { 81: "x\nError: nope\ny" },
        });
        const g = await gitlab(t, world);
        const failed = (await poll(g, jobs(["build", "unit"]))).done;
        assert.equal(failed?.summary, "Job unit failed in pipeline #8 (main at aaaaaaa)");
        assert.equal(failed?.details, "unit:\nx\nError: nope\ny");
        world.jobs[8] = [job(80, "build", "success"), job(81, "unit", "skipped")];
        assert.equal(
            (await poll(g, jobs(["unit"]))).done?.summary,
            "Job unit was skipped in pipeline #8 (main at aaaaaaa)",
        );
    });

    test("a pipeline that ends without them is a failure that names them", async (t) => {
        const world = gitlabWorld({ pipelines: [pipeline(8, "success")], jobs: { 8: [job(80, "build", "success")] } });
        const g = await gitlab(t, world);
        const { done } = await poll(g, jobs(["build", "deploy"]));
        assert.equal(done?.outcome, "failed");
        assert.equal(done?.summary, "pipeline #8 (main at aaaaaaa) ended as success without deploy");
    });
});

describe("GitLab: the artifact rules", () => {
    test("a job that passed and a version in its log that carries the commit are announced", async (t) => {
        const world = gitlabWorld({
            pipelines: [pipeline(8, "success")],
            jobs: { 8: [job(80, "build-image", "success")] },
            traces: { 80: `pushed registry/app:1.2-${SHA.slice(0, 7)}\n` },
        });
        const g = await gitlab(t, world, {
            ops: { artifacts: [{ kind: "image", check: "build-image", log: "pushed (\\S+)" }] },
        });
        const { done } = await poll(g, glSpec());
        assert.equal(done?.details, `Ready: image registry/app:1.2-${SHA.slice(0, 7)}`);
        assert.deepEqual(artifactEvents(g), [
            {
                event: "jig-ops:artifact-ready",
                payload: {
                    repo: "acme/orders-api",
                    sha: SHA,
                    kind: "image",
                    ref: `registry/app:1.2-${SHA.slice(0, 7)}`,
                    source: "log",
                },
            },
        ]);
    });
});

// ---- Jenkins ------------------------------------------------------------------------------------------------------

async function jenkins(t: TestContext, world: JenkinsWorld, more: { ci?: Raw; ops?: Raw } = {}): Promise<CiWorld> {
    return ciWorld(t, {
        ci: more.ci ?? jenkinsCi(),
        ...(more.ops === undefined ? {} : { ops: more.ops }),
        responder: jenkinsResponder(world),
        secrets: { "env:JENKINS_TOKEN": JENKINS_TOKEN },
    });
}

const jkSpec = (more: Partial<JenkinsSpec> = {}): JenkinsSpec => ({
    system: "jenkins",
    service: "orders-api",
    finish: { kind: "build" },
    since: SINCE,
    ...more,
});

describe("Jenkins: the build finished", () => {
    test("is pending while it builds, and passes when its result is SUCCESS", async (t) => {
        const world = jenkinsWorld({ builds: [build(13, null)] });
        const g = await jenkins(t, world);
        const first = await poll(g, jkSpec({ build: 13 }));
        assert.equal(first.done, undefined);
        assert.equal(first.nextPollMs, 30_000);
        assert.deepEqual(first.state, { polls: 1, found: 13 });
        world.builds[0] = build(13, "SUCCESS");
        const second = await poll(g, jkSpec({ build: 13 }), first.state);
        assert.equal(second.done?.outcome, "passed");
        assert.equal(second.done?.summary, "build #13 of orders/build succeeded in 4m12s");
        assert.deepEqual(second.done?.links, ["https://ci.example.test/job/orders/job/build/13/"]);
        assert.deepEqual(second.done?.facts, { pass: 1, fail: 0, pending: 0, skipped: 0, conclusion: "success" });
    });

    test("fails for any other result, with the lines around the first error of the console", async (t) => {
        const world = jenkinsWorld({
            builds: [build(13, "FAILURE")],
            consoles: {
                13: [
                    "Started",
                    "+ npm test",
                    "FAIL src/a.test.ts",
                    "ERROR: script returned exit code 1",
                    "Finished: FAILURE",
                ].join("\n"),
            },
        });
        const g = await jenkins(t, world);
        const failed = (await poll(g, jkSpec({ build: 13 }))).done;
        assert.equal(failed?.outcome, "failed");
        assert.equal(failed?.summary, "build #13 of orders/build ended as FAILURE");
        assert.match(
            failed?.details ?? "",
            /FAIL src\/a\.test\.ts\nERROR: script returned exit code 1\nFinished: FAILURE$/,
        );
        for (const result of ["UNSTABLE", "ABORTED", "NOT_BUILT"]) {
            world.builds[0] = build(13, result);
            assert.equal(
                (await poll(g, jkSpec({ build: 13 }))).done?.summary,
                `build #13 of orders/build ended as ${result}`,
                result,
            );
        }
    });

    test("without a number it waits for the first build scheduled after the watch began, and follows it", async (t) => {
        const world = jenkinsWorld({ builds: [build(12, "SUCCESS", { timestamp: SINCE - 3_600_000 })] });
        const g = await jenkins(t, world);
        const waiting = await poll(g, jkSpec());
        assert.equal(waiting.done, undefined);
        assert.deepEqual(waiting.state, { polls: 1 });
        world.builds.push(build(13, null, { timestamp: SINCE + 5_000 }));
        const found = await poll(g, jkSpec(), waiting.state);
        assert.equal(found.done, undefined);
        assert.deepEqual(found.state, { polls: 2, found: 13 });
        world.builds[1] = build(13, "SUCCESS", { timestamp: SINCE + 5_000 });
        world.builds.push(build(14, null, { timestamp: SINCE + 60_000 }));
        assert.equal(
            (await poll(g, jkSpec(), found.state)).done?.summary,
            "build #13 of orders/build succeeded in 4m12s",
            "the one found stays the one followed",
        );
    });

    test("a few seconds of difference between the clocks does not lose the build", async (t) => {
        const world = jenkinsWorld({ builds: [build(13, "SUCCESS", { timestamp: SINCE - 4_000 })] });
        const g = await jenkins(t, world);
        assert.equal((await poll(g, jkSpec())).done?.outcome, "passed");
    });
});

describe("Jenkins: the stages that must pass", () => {
    const stages = (...names: string[]) => jkSpec({ build: 13, finish: { kind: "stages", names } });

    test("pass when those stages pass, while the build still runs", async (t) => {
        const world = jenkinsWorld({
            builds: [build(13, null)],
            stages: {
                13: [
                    { name: "Build", status: "SUCCESS" },
                    { name: "Test", status: "SUCCESS" },
                    { name: "Deploy", status: "IN_PROGRESS" },
                ],
            },
        });
        const g = await jenkins(t, world);
        const { done } = await poll(g, stages("Build", "Test"));
        assert.equal(done?.outcome, "passed");
        assert.equal(
            done?.summary,
            "Required stages passed in build #13 of orders/build: 2 pass, 0 fail, 0 pending, 0 skipped",
        );
    });

    test("wait for a stage that has not run yet; fail at the first that fails, with the console", async (t) => {
        const world = jenkinsWorld({
            builds: [build(13, null)],
            stages: {
                13: [
                    { name: "Build", status: "SUCCESS" },
                    { name: "Test", status: "IN_PROGRESS" },
                ],
            },
            consoles: { 13: "a\nERROR: tests failed\nb" },
        });
        const g = await jenkins(t, world);
        assert.equal((await poll(g, stages("Build", "Test"))).done, undefined);
        world.stages[13] = [
            { name: "Build", status: "SUCCESS" },
            { name: "Test", status: "FAILED" },
        ];
        const failed = (await poll(g, stages("Build", "Test"))).done;
        assert.equal(failed?.outcome, "failed");
        assert.equal(failed?.summary, "Stage Test failed in build #13 of orders/build");
        assert.equal(failed?.details, "a\nERROR: tests failed\nb");
        world.stages[13] = [{ name: "Test", status: "NOT_EXECUTED" }];
        assert.equal(
            (await poll(g, stages("Test"))).done?.summary,
            "Stage Test ended as not_executed in build #13 of orders/build",
        );
    });

    test("a build that ends without them is a failure that names them", async (t) => {
        const world = jenkinsWorld({
            builds: [build(13, "SUCCESS")],
            stages: { 13: [{ name: "Build", status: "SUCCESS" }] },
        });
        const g = await jenkins(t, world);
        const { done } = await poll(g, stages("Build", "Deploy"));
        assert.equal(done?.summary, "build #13 of orders/build ended as SUCCESS without Deploy");
    });

    test("a build with no stage page cannot be watched by stage, and the poll says what is needed", async (t) => {
        const world = jenkinsWorld({ builds: [build(13, null)] });
        const g = await jenkins(t, world);
        await assert.rejects(
            poll(g, stages("Build")),
            /build #13 of orders\/build has no stage information: watching stages needs a pipeline job and the Pipeline REST API plugin/,
        );
    });

    test("a stage that passed and a rule that names it are announced, when the push is known", async (t) => {
        const world = jenkinsWorld({
            builds: [build(13, "SUCCESS")],
            stages: { 13: [{ name: "build-image", status: "SUCCESS" }] },
        });
        const g = await jenkins(t, world, { ops: { artifacts: [{ kind: "image", check: "build-image" }] } });
        const { done } = await poll(g, { ...stages("build-image"), sha: SHA });
        assert.equal(done?.details, `Ready: image ${SHA.slice(0, 7)}`);
        assert.equal((artifactEvents(g)[0]!.payload as { repo: string }).repo, "orders/build");
        const none = await jenkins(t, world, { ops: { artifacts: [{ kind: "image", check: "build-image" }] } });
        await poll(none, stages("build-image"));
        assert.deepEqual(artifactEvents(none), [], "without a commit there is nothing to tie a rule to");
    });
});

describe("the kind", () => {
    test("describes what each system watches, by the service", () => {
        assert.equal(describeSpec(glSpec()), "orders-api: pipeline of branch main at aaaaaaa");
        assert.equal(
            describeSpec(glSpec({ finish: { kind: "jobs", names: ["build"] }, pipelineId: 3 })),
            "orders-api: job build of pipeline #3",
        );
        assert.equal(describeSpec(jkSpec()), "orders-api: the next build of orders-api");
        assert.equal(
            describeSpec(jkSpec({ build: 9, finish: { kind: "stages", names: ["A", "B"] } })),
            "orders-api: required stages A, B of build #9 of orders-api",
        );
    });

    test("finds the service in the catalog as it is now: a service that went, or changed its CI system, is a failed poll", async (t) => {
        const world = gitlabWorld({ pipelines: [pipeline(8, "success")], jobs: { 8: [job(80, "build", "success")] } });
        const g = await gitlab(t, world);
        g.h.configure(section());
        await assert.rejects(
            poll(g, glSpec()),
            /^Error: orders-api now uses github-actions for CI, so this gitlab watch cannot go on$/,
        );
        g.h.configure({ services: { billing: { environments: { staging: { health: "https://b.example.test/h" } } } } });
        await assert.rejects(
            poll(g, glSpec()),
            /^InputError: ci watch: no service named "orders-api"\. Services with a ci entry: none have one$/,
        );
        g.h.configure({ nonsense: 1 });
        await assert.rejects(poll(g, glSpec()), /ops is not set up/);
    });

    test("the saved spec holds names and numbers, never an address, a project, a job or a credential", async (t) => {
        const world = gitlabWorld({ pipelines: [pipeline(8, "success")], jobs: { 8: [job(80, "build", "success")] } });
        const g = await gitlab(t, world);
        await g.call({ action: "watch", branch: "main" });
        const saved = JSON.stringify(g.h.jig.watches[0]?.spec);
        for (const text of ["ci.example.test", "acme/orders-api", "GITLAB_TOKEN", GITLAB_TOKEN, "auth"])
            assert.ok(!saved.includes(text), text);
        const other = await jenkins(t, jenkinsWorld({ builds: [build(1, null)] }));
        await other.call({ action: "watch" });
        const jenkinsSaved = JSON.stringify(other.h.jig.watches[0]?.spec);
        for (const text of ["ci.example.test", "orders/build", "JENKINS_TOKEN", JENKINS_TOKEN, "ci-bot"])
            assert.ok(!jenkinsSaved.includes(text), text);
    });

    test("a request that fails is a failed poll, and says why without the credential", async (t) => {
        const world = gitlabWorld({ pipelines: [pipeline(8, "success")] });
        const g = await gitlab(t, world);
        g.h.jig.secrets.set("env:GITLAB_TOKEN", "wrong");
        await assert.rejects(
            poll(g, glSpec()),
            (error: Error) => /HTTP 401/.test(error.message) && !error.message.includes("wrong"),
        );
    });

    test("the ops section is checked for settings the watch reads: unreadable ones leave the defaults", async (t) => {
        const world = gitlabWorld({ pipelines: [pipeline(8, "running")], jobs: { 8: [] } });
        const g = await gitlab(t, world, { ops: { watch: { pollSeconds: 1 } } });
        // pollSeconds 1 is outside 5 to 3600, so the whole section is rejected and the tools say so
        await assert.rejects(poll(g, glSpec()), /ops is not set up/);
    });
});
