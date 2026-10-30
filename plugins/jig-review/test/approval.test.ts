// What approving in the page leaves behind, over the real server and real repositories: the record, the event, and the
// message to the agent. Most tests approve with the fallback (the page, then a y in Pi); one registers a passkey through the
// server and approves with it. The ticket flow's push gate reads `approvedHeads` from the record.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { REVIEW_EVENTS } from "../src/events.ts";
import type { ReviewApprovedEvent } from "../src/events.ts";
import { fingerprintOf, fromBase64Url } from "../src/passkey/webauthn.ts";
import { FakeAuthenticator } from "./support/authenticator.ts";
import { context, git, openReview, REPOSITORIES, TICKET } from "./support/harness.ts";
import type { ReviewSession } from "./support/harness.ts";

let session: ReviewSession | undefined;
afterEach(async () => {
    await session?.close();
    session = undefined;
});

/** Presses Approve in the page without a passkey, with the user saying y in Pi. */
async function approveInPi(s: ReviewSession, answer = true) {
    s.session.answer = (title) => (title === "Approve this review?" ? answer : false);
    return s.post("/api/approve/page");
}

const json = (response: { body: string }): Record<string, unknown> => JSON.parse(response.body) as Record<string, unknown>;

test("approving a branch review records the full HEAD of every reviewed repository, and nothing else about the commits", async () => {
    session = await openReview("--branch");
    const [pending] = session.records();
    assert.equal(pending?.status, "awaiting-review");
    assert.ok(!("approvedHeads" in pending!), "nothing is vouched for before the user approves");

    const approve = await approveInPi(session);
    assert.equal(approve.status, 200);
    assert.deepEqual(json(approve), { ok: true, method: "page-and-pi" });

    const [record, ...others] = session.records();
    assert.equal(others.length, 0, "approval updates the review, it does not add one");
    assert.equal(record?.status, "approved");
    assert.equal(record?.id, pending?.id);
    assert.deepEqual(record?.approvedHeads, REPOSITORIES.map((repo) => ({ repo, sha: git(path.join(session!.root, repo), "rev-parse", "HEAD").trim() })));
    for (const head of record!.approvedHeads as Array<Record<string, unknown>>) {
        assert.deepEqual(Object.keys(head).sort(), ["repo", "sha"]);
        assert.match(String(head.sha), /^[0-9a-f]{40}$/, "a full commit, not the 12 characters the page shows");
    }
});

test("a review of uncommitted changes vouches for no commit: the branch's earlier commits were not in it", async () => {
    session = await openReview();
    assert.equal((await approveInPi(session)).status, 200);
    const [record] = session.records();
    assert.equal(record?.status, "approved");
    assert.equal(record?.fileScope, "all");
    assert.ok(!("approvedHeads" in record!));
});

test("a diff that changed after the user looked is not vouched for", async () => {
    session = await openReview("--branch");
    appendFileSync(path.join(session.root, REPOSITORIES[0]!, "Service.java"), "added after the review was opened\n");
    assert.equal((await approveInPi(session)).status, 200);
    const [record] = session.records();
    assert.equal(record?.status, "approved");
    assert.ok(!("approvedHeads" in record!), "no approvedHeads: the flow then finds no review covering any commit");
});

test("the approval is kept in the review store: how, when, and which key", async () => {
    session = await openReview("--branch");
    await approveInPi(session);
    const [record] = session.records();
    const approval = record?.approval as { method: string; at: string; fingerprint?: string };
    assert.equal(approval.method, "page-and-pi");
    assert.equal(approval.at, record?.approvedAt);
    assert.ok(!("fingerprint" in approval), "no key was used");
    assert.ok(record?.pageApprovedAt, "the click in the page is on the record too");
});

test("approving a review the agent asked for tells it how it was approved and what it covers, so it carries on", async () => {
    session = await openReview("", { byAgent: true });
    assert.equal(session.records()[0]?.fileScope, "branch");
    assert.equal((await approveInPi(session)).status, 200);
    const [message] = session.host.sent;
    const covered = REPOSITORIES.map((repo) => `${repo}@${git(path.join(session!.root, repo), "rev-parse", "HEAD").trim().slice(0, 12)}`).join(", ");
    assert.equal(message, `The user approved the ${TICKET} review in the page and then with a \`y\` in Pi, covering ${covered}. Continue with what was waiting on it (for example the push of exactly those commits; the push still asks the user to confirm).`);
    assert.equal(session.host.sent.length, 1);
});

test("an approval of a diff that changed tells the agent that asked not to push", async () => {
    session = await openReview("", { byAgent: true });
    appendFileSync(path.join(session.root, REPOSITORIES[0]!, "Service.java"), "added after the review was opened\n");
    assert.equal((await approveInPi(session)).status, 200);
    assert.match(session.host.sent[0] ?? "", /covers no commit\. Do not push: ask the user to run \/code-review again/);
});

test("an approval of the latest changes the agent asked for says it does not clear a push", async () => {
    session = await openReview("", { byAgent: true, ticket: false });
    assert.equal(session.records()[0]?.fileScope, "all");
    assert.equal((await approveInPi(session)).status, 200);
    assert.match(session.host.sent[0] ?? "", /of the latest changes in the page and then with a `y` in Pi\. It covers those changes only, not the whole branch, so it does not clear a push\./);
});

test("approving a review the user opened with /code-review is recorded and sends the agent nothing", async () => {
    session = await openReview("--branch");
    assert.equal((await approveInPi(session)).status, 200);
    assert.equal(session.records()[0]?.status, "approved");
    assert.equal(session.records()[0]?.approvedHeads !== undefined, true, "the approval is recorded as before");
    assert.deepEqual(session.host.sent, []);
});

test("approving a review the after-turn offer opened sends the agent nothing", async () => {
    session = await openReview("", { byAgent: true });
    const host = session.host;
    // The agent's review is approved and done; the run that follows changes a file and the user accepts the offer.
    assert.equal((await approveInPi(session)).status, 200);
    host.sent.length = 0;
    const offered = context(session.root);
    offered.answer = (title) => title === "Review generated code?";
    await host.fire("agent_start", offered.ctx);
    appendFileSync(path.join(session.root, REPOSITORIES[0]!, "Service.java"), "changed by the next run\n");
    await host.fire("tool_call", offered.ctx, { toolName: "edit", input: { path: path.join(session.root, REPOSITORIES[0]!, "Service.java") } });
    await host.fire("agent_end", offered.ctx);
    assert.equal(session.records().at(-1)!.fileScope, "touched");

    // The page asks Pi through the latest context, which is the one that made this review.
    offered.answer = (title) => title === "Approve this review?";
    assert.equal((await session.post("/api/approve/page")).status, 200);
    assert.equal(session.records().at(-1)?.status, "approved");
    assert.deepEqual(host.sent, []);
});

test("a review the agent asked for that the user replaced by their own no longer tells the agent", async () => {
    session = await openReview("", { byAgent: true });
    // The user's own command, in a session with no active ticket: the uncommitted changes, a different review.
    const own = context(session.root);
    own.answer = (title) => title === "Approve this review?";
    await session.host.run("code-review", "", own.ctx);
    const review = session.records().at(-1)!;
    assert.equal(review.fileScope, "all");
    assert.equal((await session.post("/api/approve/page")).status, 200);
    assert.equal(session.records().at(-1)?.status, "approved");
    assert.deepEqual(session.host.sent, []);
});

// ---- the event ---------------------------------------------------------------------------------------------------------

test("an approval is announced on the event bus, with the commits and the files", async () => {
    session = await openReview("", { byAgent: true });
    await approveInPi(session);
    const events = session.host.events.filter((event) => event.channel === REVIEW_EVENTS.approved);
    assert.equal(events.length, 1);
    assert.equal(REVIEW_EVENTS.approved, "jig-review:approved");
    const event = events[0]!.data as ReviewApprovedEvent;
    assert.equal(event.reviewId, session.records()[0]?.id);
    assert.equal(event.scope, "branch");
    assert.equal(event.ticket, TICKET);
    assert.equal(event.method, "page-and-pi");
    assert.equal(event.covered, true);
    assert.deepEqual(event.repos, REPOSITORIES.map((repo) => ({ repo, head: git(path.join(session!.root, repo), "rev-parse", "HEAD").trim() })));
    assert.deepEqual(event.files, REPOSITORIES.map((repo) => `${repo}/Service.java`));
});

test("the event says when the approval vouches for no commit, and still names where each repository stood", async () => {
    session = await openReview("");
    await approveInPi(session);
    const event = session.host.events.find((entry) => entry.channel === REVIEW_EVENTS.approved)!.data as ReviewApprovedEvent;
    assert.equal(event.scope, "all");
    assert.equal(event.covered, false);
    assert.equal(event.repos.length, 2);
    assert.ok(!("ticket" in event));
});

test("a clean repository next to the reviewed ones is not named in the event", async () => {
    session = await openReview("");
    const clean = path.join(session.root, "clean-api");
    git(session.root, "init", "-q", "-b", "main", clean);
    writeFileSync(path.join(clean, "Readme.md"), "x\n");
    git(clean, "add", ".");
    git(clean, "commit", "-q", "-m", "init");
    await approveInPi(session);
    const event = session.host.events.find((entry) => entry.channel === REVIEW_EVENTS.approved)!.data as ReviewApprovedEvent;
    assert.deepEqual(event.repos.map((repo) => repo.repo).sort(), [...REPOSITORIES].sort());
});

test("nothing is announced for a page click that Pi declined", async () => {
    session = await openReview("--branch");
    const refused = await approveInPi(session, false);
    assert.equal(refused.status, 200);
    assert.deepEqual(json(refused), { ok: false, message: "Not approved: you declined in Pi." });
    assert.deepEqual(session.host.events, []);
});

// ---- the fallback, over the server ---------------------------------------------------------------------------------------

test("the fallback approves only after y: the page's click alone leaves the review waiting, and n withdraws it", async () => {
    session = await openReview("--branch");
    let duringQuestion: Record<string, unknown> | undefined;
    session.session.answer = () => {
        duringQuestion = session!.records()[0];
        return false;
    };
    await session.post("/api/approve/page");
    assert.equal(duringQuestion?.status, "awaiting-review", "while Pi asks, the review is not approved");
    assert.ok(duringQuestion?.pageApprovedAt, "but the click in the page is on the record");
    const [declined] = session.records();
    assert.equal(declined?.status, "awaiting-review");
    assert.ok(!("pageApprovedAt" in declined!), "n withdraws the page's mark");
    assert.ok(!("approval" in declined!));

    assert.equal(json(await approveInPi(session)).ok, true);
    assert.equal(session.records()[0]?.status, "approved");
});

test("with no one to ask in Pi, the fallback does not approve", async () => {
    session = await openReview("--branch");
    (session.session.ctx as { hasUI: boolean }).hasUI = false; // no interactive session: Pi has nobody to ask
    const result = await session.post("/api/approve/page");
    assert.equal(result.status, 200);
    assert.equal(json(result).ok, false);
    assert.match(String(json(result).message), /no interactive session/);
    assert.equal(session.records()[0]?.status, "awaiting-review");
    assert.deepEqual(session.host.events, []);
});

// ---- a passkey, over the server ----------------------------------------------------------------------------------------

test("registering a passkey through the page, then approving with it, needs no y in Pi", async () => {
    session = await openReview("--branch");
    const s = session;
    const auth = new FakeAuthenticator();
    const origin = s.base;

    assert.deepEqual(json(await s.post("/api/approve/options")), { method: "none", canRegister: true });
    const registration = json(await s.post("/api/passkeys/options")) as { publicKey: { challenge: string } };
    s.session.answer = (title) => title === "Register this passkey?";
    const registered = await s.post("/api/passkeys", auth.create({ challenge: fromBase64Url(registration.publicKey.challenge), origin }));
    assert.equal(registered.status, 200, registered.body);
    const fingerprint = fingerprintOf(auth.publicKey.export({ type: "spki", format: "der" }));
    assert.equal((json(registered).passkey as { fingerprint: string }).fingerprint, fingerprint);
    assert.ok(s.session.asked.some((question) => question.includes(fingerprint.slice(0, 8))), "Pi showed the fingerprint");
    assert.equal(s.records()[0]?.status, "awaiting-review", "registering approves nothing");

    // The page lists the key, and not the key itself.
    const listed = json(await s.get("/api/passkeys")) as { passkeys: Array<Record<string, unknown>> };
    assert.deepEqual(listed.passkeys.map((key) => key.fingerprint), [fingerprint]);
    assert.ok(!JSON.stringify(listed).includes("publicKey"), "the key itself is not sent to the page");

    s.session.asked.length = 0;
    s.session.answer = () => {
        throw new Error("a passkey approval must not ask in Pi");
    };
    const options = json(await s.post("/api/approve/options")) as { method: string; publicKey: { challenge: string; rpId: string; userVerification: string } };
    assert.equal(options.method, "passkey");
    assert.equal(options.publicKey.rpId, "localhost");
    assert.equal(options.publicKey.userVerification, "required");
    const approved = await s.post("/api/approve/passkey", auth.get({ challenge: fromBase64Url(options.publicKey.challenge), origin }));
    assert.equal(approved.status, 200, approved.body);
    assert.deepEqual(json(approved), { ok: true, method: "passkey" });
    assert.deepEqual(s.session.asked, []);

    const [record] = s.records();
    assert.equal(record?.status, "approved");
    assert.deepEqual((record!.approval as { method: string; fingerprint: string }).method, "passkey");
    assert.equal((record!.approval as { fingerprint: string }).fingerprint, fingerprint);
    const event = s.host.events.find((entry) => entry.channel === REVIEW_EVENTS.approved)!.data as ReviewApprovedEvent;
    assert.equal(event.method, "passkey");
    assert.equal(event.covered, true);
    const stored = JSON.parse(readFileSync(path.join(s.agentRoot, "passkeys.json"), "utf8")) as { passkeys: unknown[] };
    assert.equal(stored.passkeys.length, 1);
});

test("a page that posts an approval without a valid signature approves nothing, however it asks", async () => {
    session = await openReview("--branch");
    const s = session;
    const auth = new FakeAuthenticator();
    const registration = json(await s.post("/api/passkeys/options")) as { publicKey: { challenge: string } };
    s.session.answer = (title) => title === "Register this passkey?";
    await s.post("/api/passkeys", auth.create({ challenge: fromBase64Url(registration.publicKey.challenge), origin: s.base }));

    // What the agent could try with a stolen cookie: no signature, a signature by its own key, a replayed or guessed challenge.
    const options = json(await s.post("/api/approve/options")) as { publicKey: { challenge: string } };
    const challenge = fromBase64Url(options.publicKey.challenge);
    const attacker = new FakeAuthenticator();
    for (const body of [
        undefined,
        {},
        { id: "x", response: {} },
        attacker.get({ challenge, origin: s.base }),
        auth.get({ challenge: Buffer.alloc(32), origin: s.base }),
        auth.get({ challenge, origin: "http://evil.example" }),
        auth.get({ challenge, origin: s.base }, { badSignature: true }),
    ]) {
        const result = await s.post("/api/approve/passkey", body);
        assert.ok(result.status >= 400, `${JSON.stringify(body)?.slice(0, 60)} got ${result.status}`);
    }
    assert.equal(s.records()[0]?.status, "awaiting-review");
    assert.deepEqual(s.host.events, []);
    assert.deepEqual(s.host.sent, []);
});

test("the old route that approved because the page asked is gone", async () => {
    session = await openReview("--branch");
    // (A GET of that path gets the page, as every address the page's router might know does.)
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await (await import("./support/harness.ts")).request(session.base, "/api/approve", { method, cookie: session.cookie });
        assert.notEqual(response.status, 200, method);
    }
    assert.equal(session.records()[0]?.status, "awaiting-review");
});

test("a review waiting for the agent cannot be approved", async () => {
    session = await openReview("--branch");
    await session.post("/api/ask", { comments: [{ body: "why?" }] });
    assert.equal(session.records()[0]?.status, "awaiting-agent");
    const result = await approveInPi(session);
    assert.equal(result.status, 409);
    assert.match(String(json(result).error), /waiting for the agent/);
    assert.equal(session.records()[0]?.status, "awaiting-agent");
});
