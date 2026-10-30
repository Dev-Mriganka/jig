// Registering a passkey and approving with one, through the approval service, with a fake authenticator in the browser's
// place and a fake Pi that answers the user's questions. Every way to get a check wrong is tried: none approves.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ApprovalError, ApprovalService } from "../src/approval.ts";
import type { ApprovalHost } from "../src/approval.ts";
import { PasskeyStore } from "../src/passkey/store.ts";
import { fingerprintOf, formatFingerprint, fromBase64Url, toBase64Url } from "../src/passkey/webauthn.ts";
import type { ApprovalMethod, ReviewRecord } from "../src/types.ts";
import { FakeAuthenticator } from "./support/authenticator.ts";
import type { Faults } from "./support/authenticator.ts";

const ORIGIN = "http://localhost:4321";
let dir = "";
let now = 0;

beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "jig-review-approval-"));
    now = Date.parse("2026-10-30T10:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function aReview(): ReviewRecord {
    return {
        id: "2026-10-30T10-00-00Z",
        headSha: "abc123def456",
        fileScope: "all",
        status: "awaiting-review",
        createdAt: "2026-10-30T10:00:00.000Z",
        updatedAt: "2026-10-30T10:00:00.000Z",
        comments: [],
        resolutions: [],
        iterations: [
            {
                id: 1,
                createdAt: "2026-10-30T10:00:00.000Z",
                diff: "diff --git a/A.ts b/A.ts\n",
                diffHash: "hash-one",
                submittedCommentIds: [],
                resolutionIds: [],
            },
        ],
    };
}

function rig() {
    const state = {
        review: aReview() as ReviewRecord | undefined,
        /** What the user answers in Pi, in order; "no" when the list runs out. */
        answers: [] as Array<"yes" | "no" | "unavailable">,
        questions: [] as Array<{ title: string; message: string }>,
        approvals: [] as Array<{ method: ApprovalMethod; fingerprint?: string }>,
        marked: 0,
        cleared: 0,
        changes: 0,
        /** Runs when Pi is asked, before the answer: what changes while the user thinks. */
        whileAsking: (() => {}) as () => void,
    };
    const host: ApprovalHost = {
        current: () => state.review,
        ask: async (title, message) => {
            state.questions.push({ title, message });
            state.whileAsking();
            return state.answers.shift() ?? "no";
        },
        pageApproved: async () => void state.marked++,
        pageDeclined: async () => void state.cleared++,
        approved: async (review, method, fingerprint) => {
            state.approvals.push({ method, ...(fingerprint === undefined ? {} : { fingerprint }) });
            review.status = "approved";
        },
        changed: () => void state.changes++,
    };
    const file = path.join(dir, "jig-review", "passkeys.json");
    const store = new PasskeyStore(file);
    const service = new ApprovalService(
        host,
        store,
        () => [ORIGIN, "http://127.0.0.1:4321"],
        () => now,
    );
    return { state, service, store, file };
}

type Rig = ReturnType<typeof rig>;

/** The page's registration: options, the authenticator's credential, the post. */
async function registerKey(r: Rig, auth: FakeAuthenticator, faults: Faults = {}) {
    const { publicKey } = r.service.registrationOptions();
    return r.service.register(auth.create({ challenge: fromBase64Url(publicKey.challenge), origin: ORIGIN }, faults));
}

/** The page's approval: options, the authenticator's signature, the post. */
async function approveKey(r: Rig, auth: FakeAuthenticator, faults: Faults = {}) {
    const options = r.service.approvalOptions();
    assert.equal(options.method, "passkey");
    if (options.method !== "passkey") throw new Error("unreachable");
    return r.service.approveWithPasskey(
        auth.get({ challenge: fromBase64Url(options.publicKey.challenge), origin: ORIGIN }, faults),
    );
}

/** A registered authenticator in a rig where the user said yes. */
async function withKey(algorithm: "ES256" | "RS256" = "ES256") {
    const r = rig();
    const auth = new FakeAuthenticator(algorithm);
    r.state.answers.push("yes");
    await registerKey(r, auth);
    r.state.questions.length = 0;
    return { r, auth };
}

async function refuses(promise: Promise<unknown>, status: number, message: RegExp): Promise<void> {
    await assert.rejects(
        promise,
        (error) => error instanceof ApprovalError && error.status === status && message.test(error.message),
        `expected ${status} ${message}`,
    );
}

// ---- registration ------------------------------------------------------------------------------------------------------

for (const algorithm of ["ES256", "RS256"] as const) {
    test(`registering a ${algorithm} passkey asks the user in Pi with its fingerprint, and stores it only after a yes`, async () => {
        const r = rig();
        const auth = new FakeAuthenticator(algorithm);
        r.state.answers.push("yes");
        const summary = await registerKey(r, auth);

        const fingerprint = fingerprintOf(auth.publicKey.export({ type: "spki", format: "der" }));
        assert.equal(summary.fingerprint, fingerprint);
        assert.equal(summary.algorithm, algorithm);
        assert.equal(r.state.questions.length, 1);
        assert.equal(r.state.questions[0]!.title, "Register this passkey?");
        assert.ok(
            r.state.questions[0]!.message.includes(formatFingerprint(fingerprint)),
            "the question shows the SHA-256 fingerprint",
        );
        const [stored] = r.store.read().passkeys;
        assert.equal(stored?.fingerprint, fingerprint);
        assert.equal(stored?.credentialId, toBase64Url(auth.credentialId));
        assert.equal(JSON.parse(readFileSync(r.file, "utf8")).passkeys.length, 1);
        assert.deepEqual(r.state.approvals, [], "registering a passkey approves nothing");
    });
}

test("a registration the user declines in Pi stores nothing", async () => {
    const r = rig();
    r.state.answers.push("no");
    await refuses(registerKey(r, new FakeAuthenticator()), 409, /you declined in Pi/);
    assert.deepEqual(r.store.read().passkeys, []);
});

test("a registration with nobody to ask in Pi stores nothing", async () => {
    const r = rig();
    r.state.answers.push("unavailable");
    await refuses(registerKey(r, new FakeAuthenticator()), 409, /declined|Pi/);
    assert.deepEqual(r.store.read().passkeys, []);
});

test("a registration is checked before the user is asked: the wrong challenge, origin, rp id, flags never reach Pi", async () => {
    for (const faults of [
        { challenge: Buffer.alloc(32, 9) },
        { origin: "http://evil.example" },
        { rpId: "example.com" },
        { userPresent: false },
        { userVerified: false },
        { type: "webauthn.get" },
    ] satisfies Faults[]) {
        const r = rig();
        r.state.answers.push("yes");
        await refuses(registerKey(r, new FakeAuthenticator(), faults), 403, /Not accepted|not current/);
        assert.deepEqual(r.state.questions, [], JSON.stringify(faults));
        assert.deepEqual(r.store.read().passkeys, []);
    }
});

test("a registration challenge is used once, and expires after two minutes", async () => {
    const r = rig();
    const auth = new FakeAuthenticator();
    const { publicKey } = r.service.registrationOptions();
    const body = auth.create({ challenge: fromBase64Url(publicKey.challenge), origin: ORIGIN });
    r.state.answers.push("no");
    await refuses(r.service.register(body), 409, /declined/);
    r.state.answers.push("yes");
    await refuses(r.service.register(body), 403, /not current/);
    assert.deepEqual(r.store.read().passkeys, [], "the replay stored nothing");

    const late = r.service.registrationOptions();
    now += 120_000;
    r.state.answers.push("yes");
    await refuses(
        r.service.register(auth.create({ challenge: fromBase64Url(late.publicKey.challenge), origin: ORIGIN })),
        403,
        /not current/,
    );
});

test("the credential id must be the one in the attestation, and a passkey is registered once", async () => {
    const r = rig();
    const auth = new FakeAuthenticator();
    const { publicKey } = r.service.registrationOptions();
    const created = auth.create({ challenge: fromBase64Url(publicKey.challenge), origin: ORIGIN });
    r.state.answers.push("yes");
    await refuses(
        r.service.register({ ...created, id: toBase64Url(Buffer.from("another id")) }),
        403,
        /does not match/,
    );

    r.state.answers.push("yes");
    await registerKey(r, auth);
    r.state.answers.push("yes");
    await refuses(registerKey(r, auth), 409, /already registered/);
    assert.equal(r.store.read().passkeys.length, 1);
});

test("registration options exclude the keys already registered, and ask for user verification, no attestation, ES256 and RS256", async () => {
    const { r, auth } = await withKey();
    const { publicKey } = r.service.registrationOptions();
    assert.deepEqual(publicKey.excludeCredentials, [{ type: "public-key", id: toBase64Url(auth.credentialId) }]);
    assert.equal(publicKey.rp.id, "localhost");
    assert.equal(publicKey.attestation, "none");
    assert.equal(publicKey.authenticatorSelection.userVerification, "required");
    assert.deepEqual(
        publicKey.pubKeyCredParams.map((param) => param.alg),
        [-7, -257],
    );
    assert.equal(fromBase64Url(publicKey.challenge).length, 32);
    assert.equal(publicKey.timeout, 120_000);
});

test("a malformed registration is refused as a bad request", async () => {
    const r = rig();
    for (const body of [
        null,
        5,
        {},
        { id: "x" },
        { id: "x", response: {} },
        { id: "!!", response: { clientDataJSON: "a", attestationObject: "a" } },
    ]) {
        await refuses(r.service.register(body), 400, /malformed|not a WebAuthn/);
    }
});

// ---- approval ----------------------------------------------------------------------------------------------------------

for (const algorithm of ["ES256", "RS256"] as const) {
    test(`approving with a ${algorithm} passkey approves, names the key, and asks nobody in Pi`, async () => {
        const { r, auth } = await withKey(algorithm);
        const result = await approveKey(r, auth);
        assert.deepEqual(result, { ok: true, method: "passkey" });
        assert.deepEqual(r.state.approvals, [
            { method: "passkey", fingerprint: fingerprintOf(auth.publicKey.export({ type: "spki", format: "der" })) },
        ]);
        assert.deepEqual(r.state.questions, [], "a passkey proves the user is present: there is no question to answer");
        assert.equal(r.store.read().passkeys[0]?.signCount, 1, "the counter is stored");
        assert.ok(r.store.read().passkeys[0]?.lastUsedAt);
    });
}

test("with no passkey registered, the options say so and offer to register", () => {
    const r = rig();
    assert.deepEqual(r.service.approvalOptions(), { method: "none", canRegister: true });
});

test("a wrong challenge approves nothing", async () => {
    const { r, auth } = await withKey();
    r.service.approvalOptions();
    await refuses(
        r.service.approveWithPasskey(auth.get({ challenge: Buffer.alloc(32, 1), origin: ORIGIN })),
        403,
        /not current/,
    );
    assert.deepEqual(r.state.approvals, []);
});

test("a challenge cannot be reused: a recorded approval cannot be replayed", async () => {
    const { r, auth } = await withKey();
    const options = r.service.approvalOptions();
    if (options.method !== "passkey") throw new Error("unreachable");
    const body = auth.get({ challenge: fromBase64Url(options.publicKey.challenge), origin: ORIGIN });
    assert.deepEqual(await r.service.approveWithPasskey(body), { ok: true, method: "passkey" });
    r.state.review!.status = "awaiting-review"; // the same review is open again, as for another round
    await refuses(r.service.approveWithPasskey(body), 403, /not current/);
    assert.equal(r.state.approvals.length, 1);
});

test("an expired challenge approves nothing", async () => {
    const { r, auth } = await withKey();
    const options = r.service.approvalOptions();
    if (options.method !== "passkey") throw new Error("unreachable");
    const body = auth.get({ challenge: fromBase64Url(options.publicKey.challenge), origin: ORIGIN });
    now += 120_000;
    await refuses(r.service.approveWithPasskey(body), 403, /not current/);
    assert.deepEqual(r.state.approvals, []);
});

test("a registration challenge cannot approve a review", async () => {
    const { r, auth } = await withKey();
    const { publicKey } = r.service.registrationOptions();
    await refuses(
        r.service.approveWithPasskey(auth.get({ challenge: fromBase64Url(publicKey.challenge), origin: ORIGIN })),
        403,
        /not current/,
    );
});

test("the wrong origin, the wrong rp id hash and a user who was not present or verified approve nothing", async () => {
    for (const [faults, message] of [
        [{ origin: "http://evil.example:4321" }, /origin/],
        [{ origin: "http://localhost:80" }, /origin/],
        [{ crossOrigin: true }, /framed/],
        [{ rpId: "example.com" }, /relying party/],
        [{ userPresent: false }, /not present/],
        [{ userVerified: false }, /not verified/],
        [{ type: "webauthn.create" }, /ceremony/],
    ] as Array<[Faults, RegExp]>) {
        const { r, auth } = await withKey();
        await refuses(approveKey(r, auth, faults), 403, message);
        assert.deepEqual(r.state.approvals, [], JSON.stringify(faults));
        assert.equal(r.state.review?.status, "awaiting-review");
    }
});

test("a bad signature, and a signature by a key that is not the registered one, approve nothing", async () => {
    const { r, auth } = await withKey();
    await refuses(approveKey(r, auth, { badSignature: true }), 403, /signature does not match/);
    const impostor = new FakeAuthenticator("ES256", { credentialId: auth.credentialId });
    await refuses(approveKey(r, impostor), 403, /signature does not match/);
    assert.deepEqual(r.state.approvals, []);
});

test("a key that was never registered approves nothing", async () => {
    const { r } = await withKey();
    const stranger = new FakeAuthenticator();
    await refuses(approveKey(r, stranger), 403, /not registered/);
    assert.deepEqual(r.state.approvals, []);
});

test("a sign count that goes backwards, or stands still, approves nothing; going up does", async () => {
    const { r, auth } = await withKey();
    await approveKey(r, auth, { signCount: 10 });
    r.state.review!.status = "awaiting-review";
    await refuses(approveKey(r, auth, { signCount: 9 }), 403, /counter did not go up/);
    await refuses(approveKey(r, auth, { signCount: 10 }), 403, /counter did not go up/);
    assert.equal(r.state.approvals.length, 1);
    assert.equal(r.store.read().passkeys[0]?.signCount, 10, "a refused attempt does not move the counter");
    await approveKey(r, auth, { signCount: 11 });
    assert.equal(r.state.approvals.length, 2);
});

test("an authenticator that reports no counter keeps approving", async () => {
    const r = rig();
    const auth = new FakeAuthenticator("ES256", { counting: false });
    r.state.answers.push("yes");
    await registerKey(r, auth);
    await approveKey(r, auth);
    r.state.review!.status = "awaiting-review";
    await approveKey(r, auth);
    assert.equal(r.state.approvals.length, 2);
});

test("approving what the user did not see: the review changed after the challenge was issued", async () => {
    const { r, auth } = await withKey();
    const options = r.service.approvalOptions();
    if (options.method !== "passkey") throw new Error("unreachable");
    const body = auth.get({ challenge: fromBase64Url(options.publicKey.challenge), origin: ORIGIN });
    r.state.review!.iterations.push({
        id: 2,
        createdAt: "x",
        diff: "newer",
        diffHash: "hash-two",
        submittedCommentIds: [],
        resolutionIds: [],
    });
    await refuses(r.service.approveWithPasskey(body), 409, /changed while you were approving/);
    assert.deepEqual(r.state.approvals, []);

    // Another review entirely.
    const next = r.service.approvalOptions();
    if (next.method !== "passkey") throw new Error("unreachable");
    const second = auth.get({ challenge: fromBase64Url(next.publicKey.challenge), origin: ORIGIN });
    r.state.review = { ...aReview(), id: "another-review" };
    await refuses(r.service.approveWithPasskey(second), 409, /changed while you were approving/);
});

test("only a review that is waiting for the user can be approved", async () => {
    const { r, auth } = await withKey();
    r.state.review!.status = "awaiting-agent";
    await refuses(
        Promise.resolve().then(() => r.service.approvalOptions()),
        409,
        /waiting for the agent/,
    );
    r.state.review!.status = "approved";
    await refuses(
        Promise.resolve().then(() => r.service.approvalOptions()),
        409,
        /already approved/,
    );
    r.state.review = undefined;
    await refuses(
        Promise.resolve().then(() => r.service.approvalOptions()),
        409,
        /No review is open/,
    );
    assert.deepEqual(r.state.approvals, []);
    void auth;
});

test("a malformed approval is a bad request, and an oversized field too", async () => {
    const { r } = await withKey();
    for (const body of [
        null,
        {},
        { id: "x", response: { clientDataJSON: "e30", authenticatorData: "a", signature: "" } },
        {
            id: "x",
            response: { clientDataJSON: toBase64Url(Buffer.alloc(5000)), authenticatorData: "AA", signature: "AA" },
        },
    ]) {
        await refuses(r.service.approveWithPasskey(body), 400, /malformed|not a WebAuthn/);
    }
});

test("two approvals at once: the second is refused while the first waits for the user in Pi", async () => {
    const r = rig();
    let release: (answer: "yes" | "no") => void = () => {};
    r.state.review = aReview();
    const host = (r.service as unknown as { host: ApprovalHost }).host;
    host.ask = () => new Promise((resolve) => (release = resolve));
    const first = r.service.approveInPage();
    await refuses(r.service.approveInPage(), 409, /Another approval is waiting/);
    release("no");
    assert.equal((await first).ok, false);
});

// ---- the passkey list and removal --------------------------------------------------------------------------------------

test("the list shows fingerprints and never the key; removing one is confirmed in Pi", async () => {
    const { r, auth } = await withKey();
    const { passkeys } = r.service.passkeys();
    const fingerprint = fingerprintOf(auth.publicKey.export({ type: "spki", format: "der" }));
    assert.deepEqual(Object.keys(passkeys[0]!).sort(), ["algorithm", "createdAt", "fingerprint"]);
    assert.equal(passkeys[0]?.fingerprint, fingerprint);

    r.state.answers.push("no");
    assert.deepEqual(await r.service.removePasskey(fingerprint), {
        ok: false,
        message: "Not removed: you declined in Pi.",
    });
    assert.equal(r.store.read().passkeys.length, 1);

    r.state.answers.push("yes");
    assert.deepEqual(await r.service.removePasskey(fingerprint), { ok: true, method: "passkey" });
    assert.deepEqual(r.store.read().passkeys, []);
    assert.equal(r.state.questions.at(-1)?.title, "Remove this passkey?");
    await refuses(r.service.removePasskey(fingerprint), 404, /No such passkey/);
});

// ---- a tampered store --------------------------------------------------------------------------------------------------

test("a store that cannot be read: no passkey approves, registration is refused, the fallback still works", async () => {
    const { r, auth } = await withKey();
    const options = r.service.approvalOptions();
    if (options.method !== "passkey") throw new Error("unreachable");
    const body = auth.get({ challenge: fromBase64Url(options.publicKey.challenge), origin: ORIGIN });
    (await import("node:fs")).writeFileSync(r.file, "{ not json");

    await refuses(r.service.approveWithPasskey(body), 403, /not registered/);
    assert.deepEqual(r.service.approvalOptions(), {
        method: "none",
        canRegister: false,
        problem: "passkeys.json is not valid JSON",
    });
    assert.throws(
        () => r.service.registrationOptions(),
        (error) => error instanceof ApprovalError && /passkeys\.json is not valid JSON/.test(error.message),
    );
    assert.deepEqual(r.service.passkeys().passkeys, []);

    r.state.answers.push("yes");
    assert.deepEqual(await r.service.approveInPage(), { ok: true, method: "page-and-pi" });
});

test("a key swapped into the store under the fingerprint the user confirmed does not approve", async () => {
    const { r, auth } = await withKey();
    const attacker = new FakeAuthenticator();
    const file = JSON.parse(readFileSync(r.file, "utf8"));
    file.passkeys[0].publicKey = attacker.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    file.passkeys[0].credentialId = toBase64Url(attacker.credentialId);
    (await import("node:fs")).writeFileSync(r.file, JSON.stringify(file), { mode: 0o600 });

    assert.deepEqual(r.service.passkeys().passkeys, []);
    assert.match(r.service.passkeys().problems[0]!, /never confirmed/);
    assert.deepEqual(r.service.approvalOptions(), { method: "none", canRegister: true });
    await refuses(approveKeyDirect(r, attacker), 403, /not registered|not current/);
    void auth;
});

/** An approval attempt with no options call first: a challenge the server never issued. */
function approveKeyDirect(r: Rig, auth: FakeAuthenticator) {
    return r.service.approveWithPasskey(auth.get({ challenge: Buffer.alloc(32, 3), origin: ORIGIN }));
}

// ---- the fallback: approved in the page, then a y in Pi ----------------------------------------------------------------

test("the fallback marks the page's approval and approves only after the user answers y in Pi", async () => {
    const r = rig();
    r.state.answers.push("yes");
    assert.deepEqual(await r.service.approveInPage(), { ok: true, method: "page-and-pi" });
    assert.equal(r.state.marked, 1, "noted as approved in the page first");
    assert.equal(r.state.questions.length, 1);
    assert.equal(r.state.questions[0]!.title, "Approve this review?");
    assert.match(r.state.questions[0]!.message, /Review 2026-10-30T10-00-00Z \(all scope, 1 file, HEAD abc123def456\)/);
    assert.deepEqual(r.state.approvals, [{ method: "page-and-pi" }]);
    assert.equal(r.state.cleared, 0);
});

test("the fallback does not approve on n, and the page's mark is withdrawn", async () => {
    const r = rig();
    r.state.answers.push("no");
    assert.deepEqual(await r.service.approveInPage(), { ok: false, message: "Not approved: you declined in Pi." });
    assert.deepEqual(r.state.approvals, []);
    assert.equal(r.state.marked, 1);
    assert.equal(r.state.cleared, 1);
});

test("the fallback does not approve when Pi cannot ask", async () => {
    const r = rig();
    r.state.answers.push("unavailable");
    const result = await r.service.approveInPage();
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /no interactive session/);
    assert.deepEqual(r.state.approvals, []);
    assert.equal(r.state.cleared, 1);
});

test("the fallback does not approve a review that changed while the user decided", async () => {
    const r = rig();
    r.state.answers.push("yes");
    r.state.whileAsking = () => {
        r.state.review!.iterations.push({
            id: 2,
            createdAt: "x",
            diff: "newer",
            diffHash: "hash-two",
            submittedCommentIds: [],
            resolutionIds: [],
        });
    };
    const result = await r.service.approveInPage();
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /changed while you were deciding/);
    assert.deepEqual(r.state.approvals, []);
    assert.equal(r.state.cleared, 1);
});
