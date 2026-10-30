// The Jenkins adapter of the ci tool, against a fake Jenkins on 127.0.0.1: status, runs, run and log, and trigger with the CSRF
// crumb, the preview of the write, the sign-in modes, and what a lost reply does. Jenkins has no rerun, and the tests say so.
// The watch probe has its tests in ci-watch.test.ts.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { describe, test } from "node:test";
import { ok } from "./support/harness.ts";
import { ciWorld } from "./support/ci-world.ts";
import type { CiWorld } from "./support/ci-world.ts";
import type { Answer, Responder } from "./support/fake-server.ts";
import { build, CRUMB, jenkinsResponder, jenkinsWorld, SESSION, TOKEN, USER } from "./support/fake-jenkins.ts";
import type { JenkinsWorld } from "./support/fake-jenkins.ts";
import { jenkinsCi } from "./support/section.ts";
import type { Raw } from "./support/section.ts";

const JOB = "/job/orders/job/build";

/** The world Jenkins has by default: a green build, and a red one whose test stage failed. */
function usual(): JenkinsWorld {
    return jenkinsWorld({
        builds: [build(11, "SUCCESS"), build(12, "FAILURE", { timestamp: Date.parse("2026-10-30T11:00:00Z") })],
        stages: {
            11: [
                { name: "Build", status: "SUCCESS", durationMillis: 30_000 },
                { name: "Test", status: "SUCCESS", durationMillis: 90_000 },
            ],
            12: [
                { name: "Build", status: "SUCCESS", durationMillis: 30_000 },
                { name: "Test", status: "FAILED", durationMillis: 90_000 },
                { name: "Deploy", status: "NOT_EXECUTED" },
            ],
        },
        consoles: {
            11: "ok\n",
            12: [
                "Started by user ci-bot",
                "[Pipeline] sh",
                "+ npm test",
                "FAIL src/a.test.ts",
                "Error: expected 2, got 3",
                "ERROR: script returned exit code 1",
                "Finished: FAILURE",
            ].join("\n"),
        },
    });
}

async function start(
    t: TestContext,
    world = usual(),
    more: { ci?: Raw; responder?: Responder; timeoutMs?: number } = {},
): Promise<CiWorld & { world: JenkinsWorld }> {
    const made = await ciWorld(t, {
        ci: more.ci ?? jenkinsCi(),
        responder: more.responder ?? jenkinsResponder(world),
        secrets: { "env:JENKINS_TOKEN": TOKEN },
        ...(more.timeoutMs === undefined ? {} : { timeoutMs: more.timeoutMs }),
    });
    return { ...made, world };
}

const BASIC = `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`;
const posts = (g: CiWorld) => g.requests.filter((request) => request.method === "POST");

describe("reads", () => {
    test("status: the last build, with its stages counted and listed, failing first", async (t) => {
        const g = await start(t);
        const result = await g.call({ action: "status" });
        assert.equal(
            ok(result),
            [
                "build #12 of orders/build: FAILURE, took 4m12s (2026-10-30T11:00); stages: 1 pass, 1 fail, 0 pending, 1 skipped",
                "fail     Test",
                "pass     Build",
                "skipped  Deploy",
                "https://ci.example.test/job/orders/job/build/12/",
            ].join("\n"),
        );
        assert.deepEqual(g.h.jig.facts.get(result.id), [
            { pass: 1, fail: 1, pending: 0, skipped: 1, conclusion: "failure" },
        ]);
        const [first] = g.requests;
        assert.equal(first?.path, `${JOB}/lastBuild/api/json`);
        assert.equal(first?.headers.authorization, BASIC, "basic authentication with the user and the API token");
        assert.equal(g.requests[1]?.path, `${JOB}/12/wfapi/describe`);
    });

    test("status of a build by number; of a build with no stage page; of a job that was never built", async (t) => {
        const g = await start(t);
        assert.match(
            ok(await g.call({ action: "status", run_id: 11 })),
            /^build #11 of orders\/build: SUCCESS, took 4m12s .*; stages: 2 pass/,
        );
        delete g.world.stages[11];
        assert.match(
            ok(await g.call({ action: "status", run_id: 11 })),
            /^build #11 of orders\/build: SUCCESS, took 4m12s \(2026-10-30T10:00\)\nhttps:/,
        );
        assert.match(
            (await g.call({ action: "status", run_id: 99 })).error?.message ?? "",
            /^orders\/build has no build 99$/,
        );
        g.world.builds = [];
        assert.match((await g.call({ action: "status" })).error?.message ?? "", /^orders\/build has no build yet$/);
    });

    test("status of a build still running is pending, never a pass", async (t) => {
        const world = usual();
        world.builds.push(build(13, null));
        world.stages[13] = [
            { name: "Build", status: "SUCCESS" },
            { name: "Test", status: "IN_PROGRESS" },
        ];
        const g = await start(t, world);
        assert.match(
            ok(await g.call({ action: "status" })),
            /^build #13 of orders\/build: BUILDING \(2026-10-30T10:00\); stages: 1 pass, 0 fail, 1 pending, 0 skipped\npending {2}Test\npass {5}Build/,
        );
    });

    test("runs: one line per build, newest first; a state filters; the limit goes to Jenkins", async (t) => {
        const g = await start(t);
        assert.equal(
            ok(await g.call({ action: "runs", limit: 5 })),
            "orders/build: 2 builds\n#12 FAILURE    2026-10-30T11:00\n#11 SUCCESS    2026-10-30T10:00",
        );
        assert.match(
            g.requests[0]?.query.get("tree") ?? "",
            /^builds\[number,result,building,timestamp,duration,url\]\{0,5\}$/,
        );
        assert.equal(
            ok(await g.call({ action: "runs", state: "success" })),
            "orders/build: 1 build\n#11 SUCCESS    2026-10-30T10:00",
        );
        assert.match(ok(await g.call({ action: "runs", state: "aborted" })), /No builds match in orders\/build\./);
        assert.match(
            (await g.call({ action: "runs", state: "weird" })).error?.message ?? "",
            /state must be one of building, success, unstable/,
        );
    });

    test("run: the build and its stages with how long each took, or why there are none", async (t) => {
        const g = await start(t);
        assert.equal(
            ok(await g.call({ action: "run", run_id: 12 })),
            [
                "build #12 of orders/build: FAILURE, took 4m12s (2026-10-30T11:00)",
                "https://ci.example.test/job/orders/job/build/12/",
                "success      Build (30s)",
                "failed       Test (1m30s)",
                "not_executed Deploy",
            ].join("\n"),
        );
        delete g.world.stages[12];
        assert.match(
            ok(await g.call({ action: "run" })),
            /\n\(no stage information: not a pipeline job, or the server lacks the Pipeline REST API plugin\)$/,
        );
    });

    test("log: the console of the last failed build, cleaned; a search; a build by number", async (t) => {
        const g = await start(t);
        const tail = ok(await g.call({ action: "log" }));
        assert.equal(tail.split("\n")[0], "Build #12 of orders/build (FAILURE): the whole log");
        assert.match(
            tail,
            /\nFAIL src\/a\.test\.ts\nError: expected 2, got 3\nERROR: script returned exit code 1\nFinished: FAILURE$/,
        );
        assert.equal(g.requests[0]?.path, `${JOB}/lastFailedBuild/api/json`);
        assert.equal(g.requests[1]?.path, `${JOB}/12/consoleText`);
        assert.equal(g.requests[1]?.headers.accept, "text/plain");
        assert.match(
            ok(await g.call({ action: "log", run_id: 12, grep: "expected" })),
            /^Build #12 of orders\/build \(FAILURE\): 1 matching lines\n5: Error: expected 2, got 3$/,
        );
        assert.match(
            ok(await g.call({ action: "log", run_id: 12, tail: 2 })),
            /: the last 2 lines; 5 earlier lines left out\nERROR: script returned exit code 1\nFinished: FAILURE$/,
        );
        assert.match(
            ok(await g.call({ action: "log", run_id: 11 })),
            /^Build #11 of orders\/build \(SUCCESS\): the whole log\nok$/,
        );
        g.world.builds = [build(11, "SUCCESS")];
        assert.match(
            (await g.call({ action: "log" })).error?.message ?? "",
            /^orders\/build has no failed build; pass run_id$/,
        );
    });

    test("log: more than 8 MiB is refused, and a secret in the log is replaced", async (t) => {
        const world = usual();
        world.consoles[12] = "token\nexport DEPLOY_PASSWORD=hunter2hunter2 done\n";
        const g = await start(t, world);
        const text = ok(await g.call({ action: "log" }));
        assert.match(text, /DEPLOY_PASSWORD=\[redacted\]/);
        assert.doesNotMatch(text, /hunter2/);
        world.consoles[12] = "x".repeat(9 * 1024 * 1024);
        assert.match((await g.call({ action: "log" })).error?.message ?? "", /the reply is larger than 8 MiB/);
    });

    test("a job in a folder, and a name with a space, are encoded part by part", async (t) => {
        const world = usual();
        world.job = "/job/my%20team/job/orders/job/build%20it";
        const g = await start(t, world, { ci: jenkinsCi({ job: "my team/orders/build it" }) });
        assert.ok(ok(await g.call({ action: "status" })));
        assert.equal(g.requests[0]?.path, "/job/my%20team/job/orders/job/build%20it/lastBuild/api/json");
    });
});

describe("what a server says when it will not", () => {
    test("Jenkins answers 403, not 401, to credentials it does not accept: the user's to fix, said once", async (t) => {
        const g = await start(t);
        g.h.jig.secrets.set("env:JENKINS_TOKEN", "wrong-token");
        const error = (await g.call({ action: "status" })).error?.message ?? "";
        assert.match(
            error,
            /^Jenkins GET lastBuild build failed: HTTP 403 \(the account may not do this, or the sign-in is missing or has expired\)$/,
        );
        assert.ok(!error.includes("wrong-token"));
    });

    test("a job that is not there is a build that is not there, and a page of HTML is not quoted", async (t) => {
        const g = await start(t, usual(), { ci: jenkinsCi({ job: "orders/missing" }) });
        assert.match(
            (await g.call({ action: "runs" })).error?.message ?? "",
            /^Jenkins GET builds failed: HTTP 404 \(not found: check the project or job in the catalog, and that the account can see it\)$/,
        );
    });

    test("a redirect is never followed", async (t) => {
        const g = await start(t, usual(), {
            responder: () => ({ status: 302, headers: { location: "https://login.example.test/" }, text: "" }),
        });
        assert.match(
            (await g.call({ action: "status" })).error?.message ?? "",
            /HTTP 302 \(the server redirected the request, which is never followed/,
        );
        assert.equal(g.requests.length, 1);
    });
});

describe("trigger", () => {
    test("is an external write that asks; a build with parameters is a POST with a crumb, a session cookie and a form body", async (t) => {
        const g = await start(t);
        const result = await g.call({ action: "trigger", parameters: { VERSION: "1.4.3", ENV: "staging" } });
        assert.deepEqual([result.cls?.environment, result.cls?.effect], ["external", "write"]);
        assert.equal(result.preview?.summary, "start a build of orders/build with 2 parameters");
        assert.match(result.preview?.body ?? "", /Parameters: ENV=staging, VERSION=1\.4\.3\nNext build number: 13\n/);
        assert.match(result.preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);
        assert.equal(ok(result), "Queued a build of orders/build. Queue item: https://ci.example.test/queue/item/13/");
        assert.deepEqual(
            g.requests.map((request) => `${request.method} ${request.path}`),
            [
                `GET ${JOB}/api/json`,
                `GET ${JOB}/api/json`,
                "GET /crumbIssuer/api/json",
                `POST ${JOB}/buildWithParameters`,
            ],
        );
        const post = posts(g)[0];
        assert.equal(post?.headers["jenkins-crumb"], CRUMB);
        assert.ok(post?.headers.cookie?.includes(SESSION), "the cookie the crumb is tied to goes back with it");
        assert.equal(post?.headers["content-type"], "application/x-www-form-urlencoded");
        assert.equal(post?.headers.authorization, BASIC);
        assert.equal(post?.body, "ENV=staging&VERSION=1.4.3");
        assert.equal(g.world.started.length, 1);
        assert.equal(g.h.jig.facts.get(result.id)?.[0]?.outcome, "queued");
    });

    test("a plain build is a POST to build, with no body", async (t) => {
        const g = await start(t);
        const result = await g.call({ action: "trigger" });
        assert.equal(result.preview?.summary, "start a build of orders/build");
        assert.match(result.preview?.body ?? "", /Parameters: none \(a plain build\)/);
        ok(result);
        assert.deepEqual(g.world.started, [{ path: "/build", body: "" }]);
        assert.equal(posts(g)[0]?.headers["content-type"], undefined);
    });

    test("a server with no crumb issuer needs no crumb, and none is sent", async (t) => {
        const world = usual();
        world.crumbs = false;
        const g = await start(t, world);
        ok(await g.call({ action: "trigger" }));
        const post = posts(g)[0];
        assert.equal(post?.headers["jenkins-crumb"], undefined);
        assert.equal(post?.headers.cookie, undefined);
        assert.equal(world.started.length, 1);
    });

    test("when the crumb cannot be had, nothing is sent and the failure is a plain one", async (t) => {
        const world = usual();
        const inner = jenkinsResponder(world);
        const g = await start(t, world, {
            responder: (request, n): Answer =>
                request.path === "/crumbIssuer/api/json"
                    ? { status: 500, text: "boom" }
                    : (inner(request, n) as Answer),
        });
        const error = (await g.call({ action: "trigger" })).error?.message ?? "";
        assert.match(error, /^Jenkins GET crumb failed: HTTP 500/);
        assert.deepEqual(posts(g), []);
    });

    test("the crumb request that times out is not a lost write: nothing was sent", async (t) => {
        const world = usual();
        const inner = jenkinsResponder(world);
        const g = await start(t, world, {
            timeoutMs: 200,
            responder: (request, n) => (request.path === "/crumbIssuer/api/json" ? { hang: true } : inner(request, n)),
        });
        const error = (await g.call({ action: "trigger" })).error?.message ?? "";
        assert.match(error, /^no answer within \d+ s$/);
        assert.deepEqual(posts(g), []);
    });

    test("a job that is disabled is refused before anyone is asked", async (t) => {
        const world = usual();
        world.buildable = false;
        const g = await start(t, world);
        const result = await g.call({ action: "trigger" });
        assert.match(
            result.error?.message ?? result.blocked ?? "",
            /orders\/build is disabled in Jenkins, so it cannot be built/,
        );
        assert.deepEqual(posts(g), []);
    });

    test("refuses to send when a build was queued after the user saw the preview", async (t) => {
        const g = await start(t);
        const result = await g.call(
            { action: "trigger" },
            { between: () => void g.world.builds.push(build(13, null)) },
        );
        assert.match(
            result.error?.message ?? "",
            /^ci trigger of orders-api changed since the preview; run it again to see the new preview\. Nothing was sent$/,
        );
        assert.deepEqual(posts(g), []);
    });

    test("a request that is already queued is merged, and the answer says so", async (t) => {
        const world = usual();
        const inner = jenkinsResponder(world);
        const g = await start(t, world, {
            responder: (request, n): Answer =>
                request.method === "POST" && request.path.endsWith("/build")
                    ? { status: 303, headers: { location: "https://ci.example.test/queue/item/5/" }, text: "" }
                    : (inner(request, n) as Answer),
        });
        const result = await g.call({ action: "trigger" });
        assert.equal(
            ok(result),
            "Queued a build of orders/build. (the same request was already queued, so it was merged with it) Queue item: https://ci.example.test/queue/item/5/",
        );
        assert.equal(g.h.jig.facts.get(result.id)?.[0]?.outcome, "merged");
    });

    test("a refusal is a plain failure and is not checked or repeated", async (t) => {
        const world = usual();
        const inner = jenkinsResponder(world);
        const g = await start(t, world, {
            responder: (request, n): Answer =>
                request.method === "POST"
                    ? { status: 400, text: "<html>Nothing is submitted</html>" }
                    : (inner(request, n) as Answer),
        });
        const error = (await g.call({ action: "trigger", parameters: { A: "1" } })).error?.message ?? "";
        assert.equal(error, "Jenkins POST build of orders/build failed: HTTP 400");
        assert.equal(posts(g).length, 1);
    });

    test("a reply that is lost is checked once: a build number that moved on means it was queued, and nothing is sent twice", async (t) => {
        const world = usual();
        const inner = jenkinsResponder(world);
        const g = await start(t, world, {
            responder: (request, n) => {
                const answer = inner(request, n);
                if (request.method !== "POST") return answer;
                world.builds.push(build(13, null));
                return { ...answer, reset: true };
            },
        });
        const text = ok(await g.call({ action: "trigger" }));
        assert.match(
            text,
            /^Queued a build of orders\/build\.\n\(The reply was lost \(.*\); one check shows it went through\. Nothing was sent twice\.\)$/,
        );
        assert.equal(posts(g).length, 1);
    });

    test("a timeout that queued nothing says so, and the build is not queued again", async (t) => {
        const world = usual();
        const inner = jenkinsResponder(world);
        const g = await start(t, world, {
            timeoutMs: 200,
            responder: (request, n) => (request.method === "POST" ? { hang: true } : inner(request, n)),
        });
        const error = (await g.call({ action: "trigger" })).error?.message ?? "";
        assert.match(
            error,
            /^Jenkins build: the reply was lost \(no answer within \d+ s\) and one check shows it did not go through\. Nothing was sent twice; run it again if you still want it\.$/,
        );
        assert.equal(posts(g).length, 1, "one POST, however long it took");
    });

    test("a gateway error after the send is a lost reply too", async (t) => {
        const world = usual();
        const inner = jenkinsResponder(world);
        const g = await start(t, world, {
            responder: (request, n): Answer =>
                request.method === "POST" ? { status: 502, text: "Bad gateway" } : (inner(request, n) as Answer),
        });
        assert.match(
            (await g.call({ action: "trigger" })).error?.message ?? "",
            /the reply was lost \(HTTP 502\) and one check shows it did not go through/,
        );
        assert.equal(posts(g).length, 1);
    });
});

describe("signing in", () => {
    test("a user and an API token, the token a secret reference, resolved once for a call of several requests", async (t) => {
        const g = await start(t);
        const result = await g.call({ action: "status" });
        assert.ok(ok(result));
        assert.ok(g.requests.length >= 2);
        assert.deepEqual(g.h.jig.resolved, ["env:JENKINS_TOKEN"], "asked once, kept for the call");
        assert.ok(!result.text.includes(TOKEN));
    });

    test("a secret that cannot be resolved stops the call before anything is sent", async (t) => {
        const g = await start(t);
        g.h.jig.secrets.clear();
        assert.equal((await g.call({ action: "status" })).error?.message, "the secret could not be resolved");
        assert.deepEqual(g.requests, []);
    });

    test("a sign-in service supplies the headers, for the crumb request and the POST too", async (t) => {
        const world = usual();
        world.authorized = (headers) => headers.authorization === "Bearer sso-1";
        const g = await start(t, world, { ci: jenkinsCi({ auth: { signIn: "corp" } }) });
        g.h.jig.signInServices.set("corp", { headers: async () => ({ authorization: "Bearer sso-1" }) });
        ok(await g.call({ action: "trigger" }));
        assert.equal(g.world.started.length, 1);
        assert.deepEqual(
            g.h.jig.signedIn.map((request) => request.system),
            ["ci:jenkins", "ci:jenkins", "ci:jenkins", "ci:jenkins"],
        );
        assert.deepEqual(g.h.jig.resolved, []);
    });

    test("a transport carries the requests, the crumb and the cookie included, and signs in itself", async (t) => {
        const world = usual();
        world.authorized = () => true;
        const g = await ciWorld(t, {
            ci: jenkinsCi({ url: "http://jenkins.internal.example.test", auth: { transport: "corp" } }),
            responder: jenkinsResponder(world),
            transport: "corp",
        });
        ok(await g.call({ action: "trigger", parameters: { A: "1" } }));
        assert.equal(g.server.requests.length, 0, "nothing went over the network");
        const post = g.transport?.requests.find((request) => request.method === "POST");
        assert.equal(post?.headers["jenkins-crumb"], CRUMB);
        assert.ok(post?.headers.cookie?.includes(SESSION));
        assert.equal(post?.headers.authorization, undefined, "no credential of ours is added");
        assert.equal(g.h.jig.sent.at(-1)?.url, `http://jenkins.internal.example.test${JOB}/buildWithParameters`);
        assert.deepEqual(g.h.jig.resolved, []);
    });

    test("no credential reaches a result or an error", async (t) => {
        const g = await start(t);
        const texts = [
            ok(await g.call({ action: "status" })),
            ok(await g.call({ action: "trigger" })),
            (await g.call({ action: "run", run_id: 99 })).error?.message ?? "",
        ];
        for (const value of g.h.jig.issued) for (const text of texts) assert.ok(!text.includes(value));
    });
});

describe("the plan of a watch", () => {
    test("a build that is running is the one followed; otherwise the next one that is scheduled", async (t) => {
        const world = usual();
        const g = await start(t, world);
        const result = await g.call({ action: "watch" });
        assert.deepEqual(g.h.jig.watches[0]?.spec, {
            system: "jenkins",
            service: "orders-api",
            finish: { kind: "build" },
            since: g.h.clock.now(),
        });
        assert.equal(g.h.jig.watches[0]?.title, "the next build of orders-api");
        assert.equal(
            ok(result),
            "Watching the next build of orders-api as watch-1. One message arrives when the build ends. The watch tool lists and stops watches.",
        );
        world.builds.push(build(13, null));
        ok(await g.call({ action: "watch" }));
        assert.equal((g.h.jig.watches[1]?.spec as { build: number }).build, 13);
        assert.equal(g.h.jig.watches[1]?.title, "build #13 of orders-api");
    });

    test("a build by number must exist; a stage by name; the stages the catalog requires", async (t) => {
        const g = await start(t, usual(), { ci: jenkinsCi({ required: ["Build", "Test"] }) });
        assert.match(
            (await g.call({ action: "watch", run_id: 99 })).error?.message ?? "",
            /orders\/build has no build 99/,
        );
        ok(await g.call({ action: "watch", run_id: 12, check: "Test" }));
        assert.deepEqual((g.h.jig.watches[0]?.spec as { finish: unknown }).finish, { kind: "stages", names: ["Test"] });
        assert.equal(g.h.jig.watches[0]?.title, "stage Test of build #12 of orders-api");
        ok(await g.call({ action: "watch", run_id: 12 }));
        assert.deepEqual((g.h.jig.watches[1]?.spec as { finish: unknown }).finish, { kind: "build" });
        ok(await g.call({ action: "watch", finish: "required" }));
        assert.deepEqual((g.h.jig.watches[2]?.spec as { finish: unknown }).finish, {
            kind: "stages",
            names: ["Build", "Test"],
        });
        assert.equal(g.h.jig.watches[2]?.title, "required stages Build, Test of the next build of orders-api");
    });

    test("takes only the finish lines Jenkins has", async (t) => {
        const g = await start(t);
        assert.match(
            (await g.call({ action: "watch", finish: "merged" })).error?.message ?? "",
            /Jenkins does not support finish merged\. It supports: required, check, run/,
        );
        assert.match(
            (await g.call({ action: "watch", finish: "check" })).error?.message ?? "",
            /finish check needs check, the name of the stage/,
        );
        assert.deepEqual(g.h.jig.watches, []);
    });
});
