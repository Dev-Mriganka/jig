// How glab is run: `glab api` with an explicit host and project path, a JSON body on standard input, a vetted repository, and
// one-line failures. GitLab is a fake `glab` that answers from fixtures; nothing here reaches a GitLab server.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { GitlabHome } from "../src/forge.ts";
import {
    answerOf,
    apiArgs,
    glabFailure,
    glabJson,
    glabPages,
    glabResponse,
    glabWrite,
    mrUrl,
    projectBase,
    statusOf,
    withQuery,
} from "../src/gitlab.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { makeRepo } from "./support/repos.ts";

let h: Harness;
before(() => {
    h = setupHarness();
});
beforeEach(() => h.reset());
after(() => h.cleanup());

let counter = 0;
/** A clone to run glab in; each test gets its own. */
const fresh = () => makeRepo(h.sb, `orders-api${++counter}`);

const HOME: GitlabHome = {
    forge: "gitlab",
    host: "gitlab.example.com",
    path: "platform/payments/orders-api",
};
const BASE = "projects/platform%2Fpayments%2Forders-api";

test("the project's path is one encoded part of the address, and a query keeps only the values that are set", () => {
    assert.equal(projectBase(HOME), BASE);
    assert.equal(projectBase({ ...HOME, path: "acme/orders-api" }), "projects/acme%2Forders-api");
    assert.equal(
        withQuery("a/b", { state: "opened", source_branch: "feature/one", draft: undefined, per_page: 20 }),
        "a/b?state=opened&source_branch=feature%2Fone&per_page=20",
    );
    assert.equal(withQuery("a/b", {}), "a/b");
    assert.equal(mrUrl(HOME, 42), "https://gitlab.example.com/platform/payments/orders-api/-/merge_requests/42");
});

test("a request is glab api with the host named, the method only when it is not GET, and the body from standard input", () => {
    assert.deepEqual(apiArgs(HOME, `${BASE}/merge_requests/42`), [
        "api",
        "--hostname",
        "gitlab.example.com",
        `${BASE}/merge_requests/42`,
    ]);
    assert.deepEqual(apiArgs(HOME, `${BASE}/merge_requests/42/discussions`, { include: true, etag: 'W/"abc"' }), [
        "api",
        "-i",
        "--hostname",
        "gitlab.example.com",
        "-H",
        'If-None-Match: W/"abc"',
        `${BASE}/merge_requests/42/discussions`,
    ]);
    assert.deepEqual(apiArgs(HOME, `${BASE}/merge_requests`, { method: "POST", body: { title: "x" } }), [
        "api",
        "--hostname",
        "gitlab.example.com",
        "-X",
        "POST",
        "--input",
        "-",
        `${BASE}/merge_requests`,
    ]);
});

test("a read runs glab in the repository, after a git call there that jig-core vets, with a fixed environment", async () => {
    const r = fresh();
    h.glab.on("api", { json: { iid: 42 } }, [`${BASE}/merge_requests/42`]);
    const found = await glabJson<{ iid: number }>(HOME, "glab api (merge request)", `${BASE}/merge_requests/42`, {
        cwd: r.dir,
    });
    assert.deepEqual(found, { iid: 42 });
    const started = h.jig.started_processes.filter((p) => p.cwd === r.dir);
    const vet = started.findIndex((p) => p.file === "git" && p.args.join(" ") === "rev-parse --git-dir");
    const run = started.findIndex((p) => p.file === "glab");
    assert.ok(vet >= 0 && run > vet, "git was run in the repository before glab");
    const env = started[run]?.env ?? {};
    for (const name of [
        "GLAB_NO_PROMPT",
        "GLAB_CHECK_UPDATE",
        "GLAB_SEND_TELEMETRY",
        "GLAB_COLOR",
        "NO_COLOR",
        "GIT_TERMINAL_PROMPT",
    ])
        assert.ok(env[name] !== undefined, name);
    assert.equal(env.GLAB_NO_PROMPT, "1");
    assert.equal(env.GLAB_CHECK_UPDATE, "false");
    assert.equal(env.GLAB_SEND_TELEMETRY, "false");
    assert.deepEqual(
        Object.keys(env).filter((name) => /TOKEN|PASSWORD|SECRET/i.test(name)),
        [],
        "no credential is handed to glab",
    );
});

test("the session bus is passed on when there is one, so a sign-in kept in the keyring can be read", async () => {
    const r = fresh();
    h.glab.on("api", { json: {} });
    const before = process.env.DBUS_SESSION_BUS_ADDRESS;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
    try {
        await glabJson(HOME, "glab api", "user", { cwd: r.dir });
        assert.equal(
            h.jig.started_processes.find((p) => p.file === "glab")?.env?.DBUS_SESSION_BUS_ADDRESS,
            "unix:path=/run/user/1000/bus",
        );
        delete process.env.DBUS_SESSION_BUS_ADDRESS;
        h.jig.reset();
        await glabJson(HOME, "glab api", "user", { cwd: r.dir });
        assert.equal(
            "DBUS_SESSION_BUS_ADDRESS" in (h.jig.started_processes.find((p) => p.file === "glab")?.env ?? {}),
            false,
        );
    } finally {
        if (before === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
        else process.env.DBUS_SESSION_BUS_ADDRESS = before;
    }
});

test("a repository whose configuration would run a command stops the call before glab starts", async () => {
    const r = fresh();
    h.glab.on("api", { json: {} });
    h.jig.refuseGit(`${r.dir}/.git/config sets core.sshcommand, which would run with your credentials`);
    await assert.rejects(glabJson(HOME, "glab api", "user", { cwd: r.dir }), /sets core\.sshcommand/);
    assert.equal(h.glab.calls().length, 0, "glab never started");
});

test("a failure is one line that names the call, and a sign-in that is missing says how to mend it", async () => {
    const r = fresh();
    h.glab.on("api", { code: 1, stderr: "glab: 401 Unauthorized (HTTP 401)\n" });
    await assert.rejects(glabJson(HOME, "glab api (merge request)", `${BASE}/merge_requests/42`, { cwd: r.dir }), {
        message:
            "glab api (merge request) failed: glab: 401 Unauthorized (HTTP 401) (glab is not signed in for gitlab.example.com: run glab auth login --hostname gitlab.example.com yourself)",
    });
    h.glab.reset();
    h.glab.on("api", { code: 1, stderr: "glab: 403 Forbidden (HTTP 403)\n" });
    await assert.rejects(
        glabJson(HOME, "glab api", "user", { cwd: r.dir }),
        /\(GitLab refused it: your role, or the token's scope, does not allow this\)$/,
    );
    h.glab.reset();
    h.glab.on("api", { code: 1, stderr: "glab: 404 Not Found (HTTP 404)\n" });
    await assert.rejects(glabJson(HOME, "glab api", "user", { cwd: r.dir }), {
        message:
            "glab api failed: glab: 404 Not Found (HTTP 404) (GitLab has nothing at that address: it is gone, or the account glab is signed in as cannot see it)",
    });
    h.glab.reset();
    h.glab.on("api", { stdout: "<html>maintenance</html>" });
    await assert.rejects(glabJson(HOME, "glab api", "user", { cwd: r.dir }), /returned output that is not JSON/);
});

test("a caller can explain a status it knows, and the sign-in hint still comes first", async () => {
    const r = fresh();
    h.glab.on("api", { code: 1, stderr: "glab: 409 Conflict (HTTP 409)" });
    await assert.rejects(
        glabWrite(
            "glab api (merge)",
            HOME,
            "PUT",
            `${BASE}/merge_requests/42/merge`,
            { sha: "a" },
            { cwd: r.dir, hints: { 409: "the head moved" } },
        ),
        { message: "glab api (merge) failed: glab: 409 Conflict (HTTP 409) (the head moved)" },
    );
    h.glab.reset();
    h.glab.on("api", { code: 1, stderr: "glab: 401 Unauthorized (HTTP 401)" });
    await assert.rejects(
        glabWrite(
            "glab api (merge)",
            HOME,
            "PUT",
            `${BASE}/merge_requests/42/merge`,
            { sha: "a" },
            { cwd: r.dir, hints: { 401: "no" } },
        ),
        /glab is not signed in for gitlab\.example\.com/,
    );
});

test("the status glab reports, and the line a failure keeps", () => {
    const failed = (stderr: string) => ({ code: 1, stdout: "", stderr, timedOut: false });
    assert.equal(statusOf(failed("glab: 405 Method Not Allowed (HTTP 405)")), 405);
    assert.equal(statusOf(failed("glab: HTTP 304")), 304);
    assert.equal(statusOf(failed("something else")), undefined);
    assert.match(glabFailure("glab api", { ...failed(""), timedOut: true }).message, /^glab api failed: timed out$/);
    assert.match(glabFailure("glab api", failed("")).message, /^glab api failed: exit 1$/);
    assert.equal(
        glabFailure("glab api", failed("dial tcp 10.0.0.1:4010: connection refused")).message,
        "glab api failed: dial tcp 10.0.0.1:4010: connection refused",
        "a port that holds the digits 401 is not a sign-in problem",
    );
});

test("a read with headers gives the status, the headers in lower case and the body; a 304 is an answer, not an error", async () => {
    const r = fresh();
    h.glab.on("api", { json: [{ id: 1 }], etag: 'W/"v1"', headers: { "X-Next-Page": "2" } }, ["discussions"]);
    const first = await glabResponse(HOME, `${BASE}/merge_requests/42/discussions`, { cwd: r.dir });
    assert.equal(first.status, 200);
    assert.equal(first.headers.etag, 'W/"v1"');
    assert.equal(first.headers["x-next-page"], "2");
    assert.deepEqual(JSON.parse(first.body), [{ id: 1 }]);
    const again = await glabResponse(HOME, `${BASE}/merge_requests/42/discussions`, { cwd: r.dir, etag: 'W/"v1"' });
    assert.equal(again.status, 304);
    assert.equal(again.body, "");
    h.glab.reset();
    h.glab.on("api", { code: 1, stderr: "glab: error connecting to gitlab.example.com" });
    const none = await glabResponse(HOME, "user", { cwd: r.dir });
    assert.equal(none.status, 0, "no answer came");
    assert.match(none.body, /error connecting/);
});

test("pages are followed while GitLab names a next page, up to the limit, and the list says when more is left", async () => {
    const r = fresh();
    h.glab.on("api", { json: [{ id: 1 }], headers: { "X-Next-Page": "2" } }, ["page=1"]);
    h.glab.on("api", { json: [{ id: 2 }], headers: { "X-Next-Page": "3" } }, ["page=2"]);
    h.glab.on("api", { json: [{ id: 3 }], headers: { "X-Next-Page": "" } }, ["page=3"]);
    const all = await glabPages<{ id: number }>(HOME, "glab api (discussions)", `${BASE}/discussions?per_page=100`, 5, {
        cwd: r.dir,
    });
    assert.deepEqual(all, { items: [{ id: 1 }, { id: 2 }, { id: 3 }], more: false });
    const cut = await glabPages<{ id: number }>(HOME, "glab api (discussions)", `${BASE}/discussions?per_page=100`, 2, {
        cwd: r.dir,
    });
    assert.deepEqual(cut, { items: [{ id: 1 }, { id: 2 }], more: true });
    h.glab.reset();
    h.glab.on("api", { status: 404, json: { message: "404 Not found" } });
    await assert.rejects(glabPages(HOME, "glab api (discussions)", `${BASE}/discussions`, 5, { cwd: r.dir }), {
        message:
            "glab api (discussions) failed: glab: 404 Not found (HTTP 404) (GitLab has nothing at that address: it is gone, or the account glab is signed in as cannot see it)",
    });
});

test("a write sends its JSON on standard input, once, and gives the answer", async () => {
    const r = fresh();
    h.glab.on("api", { json: { iid: 7, web_url: "https://gitlab.example.com/x/-/merge_requests/7" }, status: 201 }, [
        "-X",
        "POST",
    ]);
    const sent = await glabWrite(
        "glab api (create)",
        HOME,
        "POST",
        `${BASE}/merge_requests`,
        { title: 'Add "x"\nline two' },
        { cwd: r.dir },
    );
    assert.equal(sent.kind, "sent");
    if (sent.kind === "sent") assert.equal(answerOf<{ iid: number }>(sent)?.iid, 7);
    const call = h.glab.calls()[0];
    assert.deepEqual(call?.args, [
        "api",
        "--hostname",
        "gitlab.example.com",
        "-X",
        "POST",
        "--input",
        "-",
        `${BASE}/merge_requests`,
    ]);
    assert.deepEqual(JSON.parse(call?.stdin ?? ""), { title: 'Add "x"\nline two' });
    assert.equal(h.glab.calls().length, 1);
});

test("a write whose answer is lost is reported as lost, and a definite refusal is an error; neither is sent again", async () => {
    const r = fresh();
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)" });
    const lost = await glabWrite(
        "glab api (create)",
        HOME,
        "POST",
        `${BASE}/merge_requests`,
        { title: "x" },
        { cwd: r.dir },
    );
    assert.deepEqual(lost, { kind: "lost", why: "glab: 502 Bad Gateway (HTTP 502)" });
    assert.equal(h.glab.calls().length, 1);
    h.glab.reset();
    h.glab.on("api", { code: 1, stderr: "glab: 409 Conflict (HTTP 409)" });
    await assert.rejects(
        glabWrite("glab api (merge)", HOME, "PUT", `${BASE}/merge_requests/42/merge`, { sha: "a" }, { cwd: r.dir }),
        {
            message: "glab api (merge) failed: glab: 409 Conflict (HTTP 409)",
        },
    );
    h.glab.reset();
    h.glab.on("api", { sleepMs: 5000, json: {} });
    h.jig.forceTimeout(150, (file) => file === "glab");
    const slow = await glabWrite(
        "glab api (create)",
        HOME,
        "POST",
        `${BASE}/merge_requests`,
        { title: "x" },
        { cwd: r.dir },
    );
    assert.equal(slow.kind, "lost");
    h.jig.forceTimeout(undefined);
});

test("a cancelled write is lost too: the request may have left before the cancel", async () => {
    const r = fresh();
    h.glab.on("api", { sleepMs: 5000, json: {} });
    const controller = new AbortController();
    const pending = glabWrite(
        "glab api (create)",
        HOME,
        "POST",
        `${BASE}/merge_requests`,
        { title: "x" },
        { cwd: r.dir, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    assert.deepEqual(await pending, { kind: "lost", why: "the call was cancelled" });
});
