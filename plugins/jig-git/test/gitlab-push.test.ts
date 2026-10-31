// `jig-git:pushed` for a GitLab project: the push announces the project's whole path and the open merge request of the branch,
// found through glab. A remote on a host that is neither GitHub nor GitLab publishes nothing, and no listener can undo a push.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setAnnouncer } from "../src/events.ts";
import { mr } from "./support/gitlab-answers.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { commitFile, git, makeRepo } from "./support/repos.ts";
import type { Fixture } from "./support/repos.ts";

let h: Harness;
let counter = 0;

before(() => {
    h = setupHarness();
});
beforeEach(() => h.reset());
after(() => h.cleanup());

/** A clone on a feature branch cut from origin/main, not pushed, whose origin is on a GitLab host. */
function unpushed(branch: string, owner: string, host: "gitlab.com" | "gitlab.example.com"): Fixture {
    const r = makeRepo(h.sb, `push${++counter}`, owner, host);
    git(r.dir, "switch", "-q", "-c", branch, "--no-track", "origin/main");
    commitFile(r.dir, "f1.ts", "1\n", "Change 1");
    return r;
}

const pushedEvents = () =>
    h.announced.filter((entry) => entry.event === "jig-git:pushed").map((entry) => entry.payload);

test("a push to gitlab.com announces the project, the branch and the full head, and asks glab for the open merge request", async () => {
    const r = unpushed("feature/p1", "acme", "gitlab.com");
    h.glab.on("api", { json: [] });
    const text = ok(await h.call("git", { action: "push", repo: r.name }));
    const head = git(r.dir, "rev-parse", "HEAD");
    assert.match(text, /^Pushed feature\/p1 \(/);
    assert.deepEqual(pushedEvents(), [{ repo: `acme/${r.name}`, branch: "feature/p1", sha: head }]);
    assert.deepEqual(
        h.glab.callsOf("api").map((call) => call.args),
        [
            [
                "api",
                "--hostname",
                "gitlab.com",
                `projects/acme%2F${r.name}/merge_requests?source_branch=feature%2Fp1&state=opened&per_page=1`,
            ],
        ],
    );
    assert.equal(h.gh.calls().length, 0, "gh is not run for a GitLab project");
    assert.equal(h.jig.started.length, 0, "jig-git starts no watch: whoever listens does");
});

test("it says which merge request is open for the branch, when one is", async () => {
    const r = unpushed("feature/p2", "acme", "gitlab.com");
    h.glab.on("api", { json: [mr({ iid: 42 }, `acme/${r.name}`)] });
    ok(await h.call("git", { action: "push", repo: r.name }));
    assert.equal((pushedEvents()[0] as { pr?: number }).pr, 42);
});

test("a project in groups of a self-hosted GitLab is announced by its whole path", async () => {
    h.jig.setSection("git", { forges: { "gitlab.example.com": "gitlab" } });
    const r = unpushed("feature/p3", "platform/payments", "gitlab.example.com");
    h.glab.on("api", { json: [] });
    ok(await h.call("git", { action: "push", repo: r.name }));
    assert.equal((pushedEvents()[0] as { repo: string }).repo, `platform/payments/${r.name}`);
    assert.equal(h.glab.callsOf("api")[0]?.args[2], "gitlab.example.com");
});

test("a lookup that fails is no merge request, and the push is still announced", async () => {
    const r = unpushed("feature/p4", "acme", "gitlab.com");
    h.glab.on("api", { code: 1, stderr: "glab: 401 Unauthorized (HTTP 401)" });
    ok(await h.call("git", { action: "push", repo: r.name }));
    assert.deepEqual(Object.keys(pushedEvents()[0] as object).sort(), ["branch", "repo", "sha"]);
});

test("a host that is neither GitHub nor GitLab publishes nothing, runs neither program, and the push still works", async () => {
    // gitlab.example.com is not named in git.forges here, so jig-git does not know what it is.
    const r = unpushed("feature/p5", "acme", "gitlab.example.com");
    assert.match(ok(await h.call("git", { action: "push", repo: r.name })), /^Pushed feature\/p5 \(/);
    assert.deepEqual(pushedEvents(), []);
    assert.equal(h.glab.calls().length, 0);
    assert.equal(h.gh.calls().length, 0);
});

test("a listener that throws does not undo the push or lose its result", async () => {
    const r = unpushed("feature/p6", "acme", "gitlab.com");
    h.glab.on("api", { json: [] });
    setAnnouncer(() => {
        throw new Error("a listener failed");
    });
    try {
        assert.match(ok(await h.call("git", { action: "push", repo: r.name })), /^Pushed feature\/p6/);
    } finally {
        setAnnouncer((event, payload) => void h.announced.push({ event, payload }));
    }
});
