// The GitLab CI adapter of the ci tool, against a fake GitLab on 127.0.0.1: status, runs, run, log, rerun and trigger, the
// previews of the two writes, the sign-in modes, and what a lost reply does. The watch probe has its tests in ci-watch.test.ts.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { describe, test } from "node:test";
import { ok } from "./support/harness.ts";
import { ciWorld } from "./support/ci-world.ts";
import type { CiWorld } from "./support/ci-world.ts";
import type { Answer, Responder } from "./support/fake-server.ts";
import { gitlabResponder, gitlabWorld, job, pipeline, SHA, SHA2, TOKEN } from "./support/fake-gitlab.ts";
import type { GitlabWorld } from "./support/fake-gitlab.ts";
import { gitlabCi } from "./support/section.ts";
import type { Raw } from "./support/section.ts";

const PROJECT = "/api/v4/projects/acme%2Forders-api";

/** The world GitLab has by default: a failed pipeline with a green job and a red one, and an older green one. */
function usual(): GitlabWorld {
    return gitlabWorld({
        pipelines: [
            pipeline(7, "success", { sha: SHA2, created_at: "2026-10-29T09:00:00.000Z" }),
            pipeline(8, "failed", { created_at: "2026-10-30T10:00:00.000Z" }),
        ],
        jobs: {
            7: [job(70, "build", "success", { stage: "build" })],
            8: [
                job(80, "build", "success", { stage: "build" }),
                job(81, "unit", "failed", { failure_reason: "script_failure" }),
                job(82, "lint", "failed", { allow_failure: true }),
                job(83, "deploy", "skipped", { stage: "deploy" }),
            ],
        },
        traces: {
            81: [
                "\u001b[0Ksection_start:1:test\r",
                "running tests",
                "FAIL src/a.test.ts",
                "Error: expected 2, got 3",
                "Job failed: exit code 1",
            ].join("\n"),
        },
    });
}

async function start(
    t: TestContext,
    world = usual(),
    more: { ci?: Raw; responder?: Responder; timeoutMs?: number } = {},
): Promise<CiWorld & { world: GitlabWorld }> {
    const responder = more.responder ?? gitlabResponder(world);
    const made = await ciWorld(t, {
        ci: more.ci ?? gitlabCi(),
        responder,
        secrets: { "env:GITLAB_TOKEN": TOKEN },
        ...(more.timeoutMs === undefined ? {} : { timeoutMs: more.timeoutMs }),
    });
    return { ...made, world };
}

describe("reads", () => {
    test("status: the newest pipeline of a branch, its jobs counted and listed, failing first", async (t) => {
        const g = await start(t);
        const result = await g.call({ action: "status", branch: "main" });
        assert.equal(
            ok(result),
            [
                "pipeline #8 on main at aaaaaaa is failed: 2 pass, 1 fail, 0 pending, 1 skipped",
                "fail     unit https://ci.example.test/acme/orders-api/-/jobs/81",
                "pass     build https://ci.example.test/acme/orders-api/-/jobs/80",
                "pass     lint https://ci.example.test/acme/orders-api/-/jobs/82",
                "skipped  deploy https://ci.example.test/acme/orders-api/-/jobs/83",
                "https://ci.example.test/acme/orders-api/-/pipelines/8",
            ].join("\n"),
        );
        assert.deepEqual(g.h.jig.facts.get(result.id), [
            { pass: 2, fail: 1, pending: 0, skipped: 1, conclusion: "failed" },
        ]);
        const [list, jobs] = g.requests;
        assert.equal(list?.method, "GET");
        assert.equal(list?.path, `${PROJECT}/pipelines`);
        assert.equal(list?.query.get("ref"), "main");
        assert.equal(list?.query.get("per_page"), "1");
        assert.equal(jobs?.path, `${PROJECT}/pipelines/8/jobs`);
        assert.equal(list?.headers["private-token"], TOKEN, "the token travels in the PRIVATE-TOKEN header");
        assert.equal(list?.headers.authorization, undefined);
    });

    test("status by commit needs all 40 characters; by pipeline it reads that pipeline; with nothing, the newest of the project", async (t) => {
        const g = await start(t);
        assert.match(
            ok(await g.call({ action: "status", sha: SHA2 })),
            /^pipeline #7 on main at bbbbbbb is success: 1 pass/,
        );
        assert.equal(g.requests[0]?.query.get("sha"), SHA2);
        assert.match(
            (await g.call({ action: "status", sha: "bbbbbbb" })).error?.message ?? "",
            /GitLab finds pipelines by the full 40-character commit id/,
        );
        assert.match(ok(await g.call({ action: "status", run_id: 7 })), /^pipeline #7 on main/);
        assert.match(ok(await g.call({ action: "status" })), /^pipeline #8 on main/);
        assert.match(
            (await g.call({ action: "status", run_id: 7, branch: "main" })).error?.message ?? "",
            /takes one of run_id, branch or sha/,
        );
        assert.equal(ok(await g.call({ action: "status", branch: "other" })), "No pipelines match in acme/orders-api.");
        g.world.pipelines = [];
        assert.equal(ok(await g.call({ action: "status" })), "No pipelines match in acme/orders-api.");
    });

    test("status with required_only keeps the jobs the catalog names, or says that it names none", async (t) => {
        const g = await start(t, usual(), { ci: gitlabCi({ required: ["build", "unit"] }) });
        const text = ok(await g.call({ action: "status", branch: "main", required_only: true }));
        assert.match(
            text,
            /^pipeline #8 on main at aaaaaaa is failed \(required jobs\): 1 pass, 1 fail, 0 pending, 0 skipped\n/,
        );
        assert.doesNotMatch(text, /lint|deploy/);
        const plain = await start(t);
        assert.match(
            ok(await plain.call({ action: "status", branch: "main", required_only: true })),
            /No required jobs are named in the catalog, so all jobs are shown\./,
        );
    });

    test("runs: one line per pipeline; the filters are GitLab's own", async (t) => {
        const g = await start(t);
        const text = ok(await g.call({ action: "runs", branch: "main", state: "failed", limit: 5 }));
        assert.match(text, /^acme\/orders-api: 1 pipeline\n#8 failed {2}main aaaaaaa {10,}push {2}2026-10-30T10:00$/);
        const request = g.requests[0];
        assert.deepEqual(
            [request?.query.get("ref"), request?.query.get("status"), request?.query.get("per_page")],
            ["main", "failed", "5"],
        );
        assert.match(
            (await g.call({ action: "runs", state: "weird" })).error?.message ?? "",
            /state must be one of created, waiting_for_resource/,
        );
        assert.match(ok(await g.call({ action: "runs", state: "canceled" })), /No pipelines match/);
    });

    test("run: the pipeline and its jobs in order, with why a job failed", async (t) => {
        const g = await start(t);
        assert.equal(
            ok(await g.call({ action: "run", run_id: 8 })),
            [
                "Pipeline #8: failed",
                "main at aaaaaaa, push; https://ci.example.test/acme/orders-api/-/pipelines/8",
                "success    build (stage build, job 80)",
                "failed     unit (stage test, job 81): script_failure",
                "failed     lint (stage test, job 82) (allowed to fail)",
                "skipped    deploy (stage deploy, job 83)",
            ].join("\n"),
        );
        assert.match(
            (await g.call({ action: "run", run_id: 99 })).error?.message ?? "",
            /GitLab GET \/pipelines\/99 failed: HTTP 404 \(not found: check the project or job in the catalog/,
        );
    });

    test("log: the tail of the first failed job's log, cleaned; a search; a named job", async (t) => {
        const g = await start(t);
        const tail = ok(await g.call({ action: "log", branch: "main" }));
        assert.equal(tail.split("\n")[0], "Pipeline #8, job unit (failed): the whole log");
        assert.match(
            tail,
            /\nrunning tests\nFAIL src\/a\.test\.ts\nError: expected 2, got 3\nJob failed: exit code 1$/,
        );
        assert.doesNotMatch(tail, /\u001b/);
        assert.equal(g.requests[0]?.query.get("status"), "failed", "without a pipeline, the newest failed one");
        assert.match(
            ok(await g.call({ action: "log", run_id: 8, grep: "expected" })),
            /^Pipeline #8, job unit \(failed\): 1 matching lines\n4: Error: expected 2, got 3$/,
        );
        assert.equal(g.requests.at(-1)?.headers.accept, "text/plain");
        g.world.traces[80] = "all fine";
        assert.match(
            ok(await g.call({ action: "log", run_id: 8, job: "build" })),
            /job build \(success\): the whole log\nall fine$/,
        );
        assert.match(
            (await g.call({ action: "log", run_id: 8, job: "deploy" })).error?.message ?? "",
            /job deploy \(skipped\)|has no log/,
        );
        assert.match(
            (await g.call({ action: "log", run_id: 8, job: "nope" })).error?.message ?? "",
            /pipeline 8 has no job called nope; its jobs: build \(success\), unit \(failed\)/,
        );
        assert.match(
            (await g.call({ action: "log", run_id: 7 })).error?.message ?? "",
            /pipeline 7 has no failed job; its jobs: build \(success\)/,
        );
        g.world.pipelines = [];
        assert.match(
            (await g.call({ action: "log", branch: "main" })).error?.message ?? "",
            /no failed pipeline found for that branch or commit; pass run_id/,
        );
    });

    test("log: a log of more than 8 MiB is refused, not read into memory", async (t) => {
        const world = usual();
        world.traces[81] = "x".repeat(9 * 1024 * 1024);
        const g = await start(t, world);
        assert.match(
            (await g.call({ action: "log", run_id: 8 })).error?.message ?? "",
            /the reply is larger than 8 MiB/,
        );
    });

    test("log: a secret the job printed is replaced", async (t) => {
        const world = usual();
        world.traces[81] = "start\nexport API_TOKEN=glpat-abcdefghij0123456789 done\nend";
        const g = await start(t, world);
        const text = ok(await g.call({ action: "log", run_id: 8 }));
        assert.match(text, /API_TOKEN=\[redacted\]/);
        assert.doesNotMatch(text, /glpat-abcdefghij/);
    });
});

describe("what a server says when it will not", () => {
    test("an expired or wrong token: the user's to fix, said once, without the token", async (t) => {
        const g = await start(t);
        g.h.jig.secrets.set("env:GITLAB_TOKEN", "wrong-token");
        const error = (await g.call({ action: "runs" })).error?.message ?? "";
        assert.equal(
            error,
            "GitLab GET /pipelines failed: HTTP 401 (the server did not accept the sign-in: sign in again yourself; 401 Unauthorized)",
        );
        assert.ok(!error.includes("wrong-token"));
    });

    test("a project or a pipeline that is not there says to check the catalog", async (t) => {
        const g = await start(t, usual(), { ci: gitlabCi({ project: "acme/missing" }) });
        assert.match(
            (await g.call({ action: "runs" })).error?.message ?? "",
            /HTTP 404 \(not found: check the project or job in the catalog, and that the account can see it; 404 Not Found\)/,
        );
    });

    test("a redirect is never followed: the token would go to an address the catalog never named", async (t) => {
        const g = await start(t, usual(), {
            responder: () => ({ status: 301, headers: { location: "https://elsewhere.example.test/x" }, text: "" }),
        });
        const error = (await g.call({ action: "runs" })).error?.message ?? "";
        assert.match(
            error,
            /HTTP 301 \(the server redirected the request, which is never followed; check the url in the catalog\)/,
        );
        assert.equal(g.requests.length, 1);
    });

    test("a server that is not there is said so in words of ours, with no address in them", async (t) => {
        const refused = Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND ci.example.test" },
        });
        const g = await ciWorld(t, {
            ci: gitlabCi(),
            responder: gitlabResponder(usual()),
            secrets: { "env:GITLAB_TOKEN": TOKEN },
            fetch: async () => {
                throw refused;
            },
        });
        const error = (await g.call({ action: "runs" })).error?.message ?? "";
        assert.equal(
            error,
            "cannot reach the CI server (ENOTFOUND): check the url in the catalog, the network and the certificate",
        );
        assert.ok(!error.includes("example.test"));
    });

    test("a rate limit says how long to wait", async (t) => {
        const g = await start(t, usual(), {
            responder: () => ({ status: 429, headers: { "retry-after": "17" }, json: { message: "Retry later" } }),
        });
        assert.match(
            (await g.call({ action: "runs" })).error?.message ?? "",
            /HTTP 429 \(rate limited: try again in 17 s; Retry later\)/,
        );
    });

    test("a server that does not answer in time is a timeout", async (t) => {
        const g = await start(t, usual(), { responder: () => ({ hang: true }), timeoutMs: 150 });
        assert.match(
            (await g.call({ action: "runs" })).error?.message ?? "",
            /^no answer within 0 s$|no answer within \d+ s/,
        );
    });
});

describe("rerun", () => {
    test("previews the failed jobs, is an external write, and sends one POST", async (t) => {
        const g = await start(t);
        const result = await g.call({ action: "rerun", run_id: 8 });
        assert.deepEqual([result.cls?.environment, result.cls?.effect], ["external", "write"]);
        assert.equal(
            result.preview?.summary,
            "retry the failed jobs of pipeline 8 (main, aaaaaaa) in acme/orders-api: unit, lint",
        );
        assert.match(result.preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);
        assert.equal(ok(result), "Started a retry of the failed jobs of pipeline #8 in acme/orders-api: unit, lint.");
        const posts = g.requests.filter((request) => request.method === "POST");
        assert.deepEqual(
            posts.map((request) => request.path),
            [`${PROJECT}/pipelines/8/retry`],
        );
        assert.deepEqual(g.world.retried, [8]);
        assert.equal(g.h.jig.facts.get(result.id)?.[0]?.outcome, "started");
    });

    test("is refused for a pipeline that is still running, one with nothing to retry, and for everything at once", async (t) => {
        const g = await start(t);
        g.world.pipelines[1]!.status = "running";
        assert.match(
            (await g.call({ action: "rerun", run_id: 8 })).error?.message ?? "",
            /pipeline 8 is running; a pipeline can be retried once it has finished/,
        );
        assert.match(
            (await g.call({ action: "rerun", run_id: 7 })).error?.message ?? "",
            /pipeline 7 has no failed or cancelled jobs, so there is nothing to retry/,
        );
        g.world.pipelines[1]!.status = "failed";
        const all = await g.call({ action: "rerun", run_id: 8, failed_only: false });
        assert.match(
            all.blocked ?? "",
            /ci rerun: GitLab CI retries the failed jobs of a pipeline only\. To run everything again, use ci trigger on the same ref/,
        );
        assert.deepEqual(g.world.retried, []);
    });

    test("refuses to send when a job changed after the user saw the preview", async (t) => {
        const g = await start(t);
        const result = await g.call(
            { action: "rerun", run_id: 8 },
            { between: () => void (g.world.jobs[8]![1]!.status = "success") },
        );
        assert.match(
            result.error?.message ?? "",
            /^ci rerun of orders-api changed since the preview; run it again to see the new preview\. Nothing was sent$/,
        );
        assert.deepEqual(g.world.retried, []);
    });

    test("a reply that is lost is checked once: the pipeline running again means it went through, and nothing is sent twice", async (t) => {
        const world = usual();
        const inner = gitlabResponder(world);
        const g = await start(t, world, {
            responder: (request, n) =>
                request.method === "POST" ? { ...inner(request, n), reset: true } : inner(request, n),
        });
        const text = ok(await g.call({ action: "rerun", run_id: 8 }));
        assert.match(text, /^Started a retry of the failed jobs of pipeline #8/);
        assert.match(
            text,
            /\(The reply was lost \(the connection broke before the reply came \((?:ECONNRESET|UND_ERR_SOCKET)\)\); one check shows it went through\. Nothing was sent twice\.\)$/,
        );
        assert.equal(g.requests.filter((request) => request.method === "POST").length, 1);
    });

    test("a timeout is not sent again either: when the server never acted, the check says so", async (t) => {
        const world = usual();
        const inner = gitlabResponder(world);
        const g = await start(t, world, {
            timeoutMs: 200,
            responder: (request, n) => (request.method === "POST" ? { hang: true } : inner(request, n)),
        });
        const error = (await g.call({ action: "rerun", run_id: 8 })).error?.message ?? "";
        assert.match(
            error,
            /^GitLab retry: the reply was lost \(no answer within \d+ s\) and one check shows it did not go through\. Nothing was sent twice; run it again if you still want it\.$/,
        );
        assert.equal(
            g.requests.filter((request) => request.method === "POST").length,
            1,
            "one POST, however long it took",
        );
    });

    test("a refusal from the server is a plain failure and is not checked or repeated", async (t) => {
        const world = usual();
        const inner = gitlabResponder(world);
        const g = await start(t, world, {
            responder: (request, n): Answer =>
                request.method === "POST"
                    ? { status: 409, json: { message: "Retry already running" } }
                    : (inner(request, n) as Answer),
        });
        assert.match(
            (await g.call({ action: "rerun", run_id: 8 })).error?.message ?? "",
            /GitLab POST \/pipelines\/8\/retry failed: HTTP 409 \(the server is busy with the same thing; wait, then look again; Retry already running\)/,
        );
        assert.equal(g.requests.filter((request) => request.method === "POST").length, 1);
    });
});

describe("trigger", () => {
    test("previews the ref and the variables, is an external write, and creates one pipeline", async (t) => {
        const g = await start(t);
        const result = await g.call({ action: "trigger", ref: "main", parameters: { DEPLOY_ENV: "staging", A: "1" } });
        assert.deepEqual([result.cls?.environment, result.cls?.effect], ["external", "write"]);
        assert.equal(result.preview?.summary, "create a pipeline on main in acme/orders-api with 2 variables");
        assert.match(
            result.preview?.body ?? "",
            /Ref: {7}main\nVariables: A=1, DEPLOY_ENV=staging\nLatest on this ref: #8 failed {2}main aaaaaaa\n/,
        );
        assert.match(
            ok(result),
            /^Created pipeline #9 on main \(pending\) in acme\/orders-api: https:\/\/ci\.example\.test\//,
        );
        const post = g.requests.find((request) => request.method === "POST");
        assert.equal(post?.path, `${PROJECT}/pipeline`);
        assert.equal(post?.query.get("ref"), "main");
        assert.equal(post?.headers["content-type"], "application/json");
        assert.deepEqual(JSON.parse(post?.body ?? ""), {
            variables: [
                { key: "A", value: "1", variable_type: "env_var" },
                { key: "DEPLOY_ENV", value: "staging", variable_type: "env_var" },
            ],
        });
        assert.equal(g.h.jig.facts.get(result.id)?.[0]?.outcome, "created");
    });

    test("without variables the POST has no body", async (t) => {
        const g = await start(t);
        ok(await g.call({ action: "trigger", ref: "release/1.2" }));
        const post = g.requests.find((request) => request.method === "POST");
        assert.equal(post?.body, "");
        assert.equal(post?.query.get("ref"), "release/1.2");
        assert.equal(post?.path, `${PROJECT}/pipeline`);
    });

    test("refuses to send when another pipeline appeared on the ref after the user saw the preview", async (t) => {
        const g = await start(t);
        const result = await g.call(
            { action: "trigger", ref: "main" },
            { between: () => void g.world.pipelines.push(pipeline(9, "running")) },
        );
        assert.match(
            result.error?.message ?? "",
            /^ci trigger of orders-api changed since the preview; run it again to see the new preview\. Nothing was sent$/,
        );
        assert.deepEqual(g.world.created, []);
    });

    test("a reply that is lost is checked once: a newer pipeline on the ref means it was created, and nothing is sent twice", async (t) => {
        const world = usual();
        const inner = gitlabResponder(world);
        const g = await start(t, world, {
            responder: (request, n) =>
                request.method === "POST" ? { ...inner(request, n), reset: true } : inner(request, n),
        });
        const text = ok(await g.call({ action: "trigger", ref: "main" }));
        assert.match(text, /^Created pipeline #9 on main \(pending\)/);
        assert.match(text, /one check shows it went through\. Nothing was sent twice\.\)$/);
        assert.equal(world.created.length, 1);
    });

    test("a timeout that created nothing says so, and the create is not sent again", async (t) => {
        const world = usual();
        const inner = gitlabResponder(world);
        const g = await start(t, world, {
            timeoutMs: 200,
            responder: (request, n) => (request.method === "POST" ? { hang: true } : inner(request, n)),
        });
        assert.match(
            (await g.call({ action: "trigger", ref: "main" })).error?.message ?? "",
            /one check shows it did not go through\. Nothing was sent twice/,
        );
        assert.equal(g.requests.filter((request) => request.method === "POST").length, 1);
    });

    test("a refusal such as an unknown ref is a plain failure with the server's words", async (t) => {
        const world = usual();
        const inner = gitlabResponder(world);
        const g = await start(t, world, {
            responder: (request, n): Answer =>
                request.method === "POST"
                    ? { status: 400, json: { message: { base: ["Reference not found"] } } }
                    : (inner(request, n) as Answer),
        });
        assert.match(
            (await g.call({ action: "trigger", ref: "nope" })).error?.message ?? "",
            /GitLab POST \/pipeline failed: HTTP 400 \(.*Reference not found/,
        );
    });
});

describe("signing in", () => {
    test("a token is a secret reference, resolved when the request is made and never shown", async (t) => {
        const g = await start(t);
        const result = await g.call({ action: "runs" });
        assert.ok(ok(result));
        assert.deepEqual(g.h.jig.resolved, ["env:GITLAB_TOKEN"]);
        assert.ok(!result.text.includes(TOKEN));
    });

    test("a secret that cannot be resolved stops the call before anything is sent", async (t) => {
        const g = await start(t);
        g.h.jig.secrets.clear();
        assert.equal((await g.call({ action: "runs" })).error?.message, "the secret could not be resolved");
        assert.deepEqual(g.requests, []);
    });

    test("a sign-in service supplies the headers of each request, and is told which system and address", async (t) => {
        const world = usual();
        world.authorized = (headers) => headers.authorization === "Bearer sso-1";
        const g = await start(t, world, { ci: gitlabCi({ auth: { signIn: "corp" } }) });
        g.h.jig.signInServices.set("corp", { headers: async () => ({ authorization: "Bearer sso-1" }) });
        assert.ok(ok(await g.call({ action: "runs" })));
        assert.deepEqual(g.h.jig.signedIn, [
            { system: "ci:gitlab", url: `https://ci.example.test${PROJECT}/pipelines?per_page=20` },
        ]);
        assert.equal(g.requests[0]?.headers["private-token"], undefined, "no token of ours was sent");
        assert.deepEqual(g.h.jig.resolved, [], "no secret was asked for");
    });

    test("a sign-in service that does not exist says so", async (t) => {
        const g = await start(t, usual(), { ci: gitlabCi({ auth: { signIn: "missing" } }) });
        assert.equal((await g.call({ action: "runs" })).error?.message, 'no sign-in service is named "missing"');
    });

    test("a transport carries the request, signs it in itself, and may speak plain http", async (t) => {
        const world = usual();
        world.authorized = () => true;
        const g = await ciWorld(t, {
            ci: gitlabCi({ url: "http://gitlab.internal.example.test", auth: { transport: "corp" } }),
            responder: gitlabResponder(world),
            transport: "corp",
        });
        const result = await g.call({ action: "status", branch: "main" });
        assert.match(ok(result), /^pipeline #8 on main/);
        assert.equal(g.server.requests.length, 0, "nothing went over the network");
        assert.equal(g.transport?.requests.length, 2);
        const sent = g.h.jig.sent[0];
        assert.deepEqual([sent?.system, sent?.method], ["ci:gitlab", "GET"]);
        assert.equal(sent?.url, `http://gitlab.internal.example.test${PROJECT}/pipelines?per_page=1&ref=main`);
        assert.equal(g.transport?.requests[0]?.headers["private-token"], undefined, "no credential of ours is added");
        assert.deepEqual(g.h.jig.resolved, []);
    });

    test("a transport that fails is reported by name, and a write through it is still sent once", async (t) => {
        const world = usual();
        world.authorized = () => true;
        const inner = gitlabResponder(world);
        const g = await ciWorld(t, {
            ci: gitlabCi({ url: "http://gitlab.internal.example.test", auth: { transport: "corp" } }),
            responder: (request, n) => (request.method === "POST" ? { hang: true } : inner(request, n)),
            transport: "corp",
            timeoutMs: 200,
        });
        const error = (await g.call({ action: "rerun", run_id: 8 })).error?.message ?? "";
        assert.match(error, /one check shows it did not go through\. Nothing was sent twice/);
        assert.equal(g.transport?.requests.filter((request) => request.method === "POST").length, 1);
    });
});

describe("the plan of a watch", () => {
    test("a branch: the newest pipeline now is the one followed, and the title says what it is", async (t) => {
        const g = await start(t);
        const result = await g.call({ action: "watch", branch: "main" });
        assert.equal(g.h.jig.watches[0]?.kind, "ops-ci");
        assert.deepEqual(g.h.jig.watches[0]?.spec, {
            system: "gitlab",
            service: "orders-api",
            finish: { kind: "pipeline" },
            since: g.h.clock.now(),
            ref: "main",
            pipelineId: 8,
            sha: SHA,
        });
        assert.equal(g.h.jig.watches[0]?.title, "pipeline #8");
        assert.equal(
            ok(result),
            "Watching pipeline #8 as watch-1. One message arrives when the pipeline ends, or one of its jobs fails. The watch tool lists and stops watches.",
        );
    });

    test("a commit, a pipeline, a named job and the catalog's required jobs", async (t) => {
        const g = await start(t, usual(), { ci: gitlabCi({ required: ["build", "unit"] }) });
        ok(await g.call({ action: "watch", sha: SHA2 }));
        assert.deepEqual(g.h.jig.watches[0]?.spec, {
            system: "gitlab",
            service: "orders-api",
            finish: { kind: "jobs", names: ["build", "unit"] },
            since: g.h.clock.now(),
            sha: SHA2,
        });
        assert.equal(g.h.jig.watches[0]?.title, `required jobs build, unit of commit ${SHA2.slice(0, 7)}`);
        ok(await g.call({ action: "watch", run_id: 7, finish: "run" }));
        assert.equal(g.h.jig.watches[1]?.title, "pipeline #7");
        ok(await g.call({ action: "watch", run_id: 7, check: "build" }));
        assert.deepEqual((g.h.jig.watches[2]?.spec as { finish: unknown }).finish, { kind: "jobs", names: ["build"] });
        assert.equal(g.h.jig.watches[2]?.title, "job build of pipeline #7");
    });

    test("needs a pipeline, a branch or a commit; and takes only the finish lines GitLab has", async (t) => {
        const g = await start(t);
        assert.match((await g.call({ action: "watch" })).error?.message ?? "", /needs run_id, branch or sha/);
        assert.match(
            (await g.call({ action: "watch", branch: "main", finish: "merged" })).error?.message ?? "",
            /GitLab CI does not support finish merged/,
        );
        assert.match(
            (await g.call({ action: "watch", branch: "main", finish: "check" })).error?.message ?? "",
            /finish check needs check, the name of the job/,
        );
        assert.deepEqual(g.h.jig.watches, []);
    });
});
