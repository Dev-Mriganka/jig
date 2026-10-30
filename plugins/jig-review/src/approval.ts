// How a review gets approved in its page. There are two ways, and both end with the user's own act:
//
//   - A passkey (WebAuthn). The page asks the device to sign a fresh challenge; the device checks the person (Windows
//     Hello, Touch ID, a PIN) and signs; this module verifies the signature against a key the user registered. The agent
//     cannot make that signature, so a passkey approval needs no `y` in Pi.
//   - The fallback: the page says "approved", and Pi asks the user `y` or `n`. Only a `y` approves.
//
// A key is registered the same way: the page creates it, and before it is stored Pi shows its fingerprint and asks the
// user. Nothing here reads a secret: the passkey store holds public keys.
import { randomBytes } from "node:crypto";
import { filesOfDiff } from "./diff.ts";
import { ChallengeBook, CHALLENGE_TTL_MS } from "./passkey/challenges.ts";
import { type PasskeyStore, PasskeyStoreError } from "./passkey/store.ts";
import {
    challengeOf,
    fingerprintOf,
    formatFingerprint,
    fromBase64Url,
    publicKeyFromSpki,
    RP_ID,
    toBase64Url,
    verifyAssertion,
    verifyRegistration,
    WebAuthnError,
} from "./passkey/webauthn.ts";
import type { ApprovalMethod, PasskeySummary, ReviewRecord } from "./types.ts";

/** What went wrong, with the HTTP status the server answers. The message is for the person at the page. */
export class ApprovalError extends Error {
    public readonly status: number;
    public constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

/** What an approval needs from the coordinator. */
export interface ApprovalHost {
    /** The review the page is showing as the one to approve; undefined when none is open. */
    current(): ReviewRecord | undefined;
    /** Asks the user in Pi. "unavailable" when Pi has nobody to ask (no interactive session, or the session ended). */
    ask(title: string, message: string): Promise<"yes" | "no" | "unavailable">;
    /** The page's Approve was clicked without a passkey: notes it on the record. Not an approval. */
    pageApproved(review: ReviewRecord): Promise<void>;
    /** Pi answered `n` to a page approval. */
    pageDeclined(review: ReviewRecord): Promise<void>;
    /** Records the approval, announces it and tells the agent. Called only after the approval was verified. */
    approved(review: ReviewRecord, method: ApprovalMethod, fingerprint?: string): Promise<void>;
    /** Tells the open pages that something changed. */
    changed(): void;
}

export type ApprovalOptions =
    | { method: "passkey"; publicKey: PublicKeyRequest }
    | { method: "none"; canRegister: boolean; problem?: string };

export type PublicKeyRequest = {
    challenge: string;
    rpId: string;
    timeout: number;
    userVerification: "required";
    allowCredentials: Array<{ type: "public-key"; id: string }>;
};

export type RegistrationOptions = {
    publicKey: {
        rp: { id: string; name: string };
        user: { id: string; name: string; displayName: string };
        challenge: string;
        pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
        timeout: number;
        attestation: "none";
        authenticatorSelection: { userVerification: "required"; residentKey: "discouraged" };
        excludeCredentials: Array<{ type: "public-key"; id: string }>;
    };
};

export type ApprovalResult = { ok: true; method: ApprovalMethod } | { ok: false; message: string };

/** What a challenge was issued for. An approval is bound to the review and the diff the user was looking at. */
type Binding = { reviewId: string; diffHash: string } | undefined;

const MAX_CLIENT_DATA = 4096;
const MAX_AUTHENTICATOR_DATA = 2048;
const MAX_ATTESTATION = 16 * 1024;
const MAX_SIGNATURE = 1024;

export class ApprovalService {
    private readonly host: ApprovalHost;
    private readonly store: PasskeyStore;
    private readonly origins: () => readonly string[];
    private readonly now: () => number;
    private readonly challenges: ChallengeBook<Binding>;
    /** One approval, registration or removal at a time: each may be waiting on the user in Pi. */
    private busy = false;

    public constructor(host: ApprovalHost, store: PasskeyStore, origins: () => readonly string[], now: () => number = Date.now) {
        this.host = host;
        this.store = store;
        this.origins = origins;
        this.now = now;
        this.challenges = new ChallengeBook<Binding>(now);
    }

    /** Forgets every challenge: the server stopped. */
    public stop(): void {
        this.challenges.clear();
    }

    // ---- the passkeys ----------------------------------------------------------------------------------------------

    public passkeys(): { passkeys: PasskeySummary[]; problems: string[]; problem?: string } {
        const read = this.store.read();
        return {
            passkeys: read.passkeys.map(summary),
            problems: read.problems,
            ...(read.unusable === undefined ? {} : { problem: `passkeys.json ${read.unusable}` }),
        };
    }

    /** Removes a registered passkey, after the user says yes in Pi. */
    public async removePasskey(fingerprint: string): Promise<ApprovalResult> {
        return this.exclusive(async () => {
            const key = this.store.read().passkeys.find((entry) => entry.fingerprint === fingerprint);
            if (key === undefined) throw new ApprovalError(404, "No such passkey.");
            const answer = await this.host.ask(
                "Remove this passkey?",
                `The passkey with SHA-256 fingerprint\n  ${formatFingerprint(key.fingerprint)}\nwill no longer approve reviews. Remove it?`,
            );
            if (answer !== "yes") return { ok: false, message: "Not removed: you declined in Pi." };
            this.mutate(() => this.store.remove(fingerprint));
            this.host.changed();
            return { ok: true, method: "passkey" };
        });
    }

    // ---- registration ----------------------------------------------------------------------------------------------

    /** What the page passes to `navigator.credentials.create`. */
    public registrationOptions(): RegistrationOptions {
        const read = this.store.read();
        if (read.unusable !== undefined) throw new ApprovalError(409, `Cannot register: passkeys.json ${read.unusable}.`);
        const challenge = this.challenges.issue("register", undefined);
        return {
            publicKey: {
                rp: { id: RP_ID, name: "Jig code review" },
                // A new random user handle each time, so a second registration does not replace the first on the authenticator.
                user: { id: toBase64Url(randomBytes(16)), name: "reviewer", displayName: "Jig code reviewer" },
                challenge: toBase64Url(challenge.value),
                pubKeyCredParams: [
                    { type: "public-key", alg: -7 },
                    { type: "public-key", alg: -257 },
                ],
                timeout: CHALLENGE_TTL_MS,
                attestation: "none",
                authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
                excludeCredentials: read.passkeys.map((key) => ({ type: "public-key", id: key.credentialId })),
            },
        };
    }

    /**
     * Checks a new credential, shows its fingerprint in Pi and stores it when the user says yes. Registering a passkey does
     * not approve anything.
     */
    public async register(body: unknown): Promise<PasskeySummary> {
        return this.exclusive(async () => {
            const input = readBody(body, ["clientDataJSON", "attestationObject"], { clientDataJSON: MAX_CLIENT_DATA, attestationObject: MAX_ATTESTATION });
            const challenge = this.challenges.take("register", challengeFrom(input.clientDataJSON));
            if (challenge === undefined) throw new ApprovalError(403, "That registration is not current: the challenge was used, expired or never issued. Try again.");
            let registration: ReturnType<typeof verifyRegistration>;
            try {
                registration = verifyRegistration({
                    clientDataJSON: input.clientDataJSON,
                    attestationObject: input.attestationObject,
                    expectedChallenge: challenge.value,
                    allowedOrigins: this.origins(),
                });
            } catch (error) {
                throw asApprovalError(error);
            }
            if (!input.id.equals(registration.credentialId)) throw new ApprovalError(403, "The credential id does not match the attestation.");

            const fingerprint = fingerprintOf(registration.key.spki);
            const answer = await this.host.ask(
                "Register this passkey?",
                `A passkey was just created for the review page. Its SHA-256 fingerprint is\n  ${formatFingerprint(fingerprint)}\n` +
                    "Answer y only if you created it just now: it will be able to approve reviews without asking you here again.",
            );
            if (answer !== "yes") throw new ApprovalError(409, "Not registered: you declined in Pi.");

            const at = new Date(this.now()).toISOString();
            const stored = {
                credentialId: toBase64Url(registration.credentialId),
                algorithm: registration.key.algorithm,
                publicKey: registration.key.spki.toString("base64"),
                fingerprint,
                signCount: registration.signCount,
                createdAt: at,
                confirmedAt: at,
            };
            this.mutate(() => this.store.add(stored));
            this.host.changed();
            return summary(stored);
        });
    }

    // ---- approval --------------------------------------------------------------------------------------------------

    /** Which way the page can approve now: with a registered passkey (and its challenge), or not yet. */
    public approvalOptions(): ApprovalOptions {
        const review = this.openReview();
        const read = this.store.read();
        if (read.passkeys.length === 0) {
            return {
                method: "none",
                canRegister: read.unusable === undefined,
                ...(read.unusable === undefined ? {} : { problem: `passkeys.json ${read.unusable}` }),
            };
        }
        const challenge = this.challenges.issue("approve", { reviewId: review.id, diffHash: diffHashOf(review) });
        return {
            method: "passkey",
            publicKey: {
                challenge: toBase64Url(challenge.value),
                rpId: RP_ID,
                timeout: CHALLENGE_TTL_MS,
                userVerification: "required",
                allowCredentials: read.passkeys.map((key) => ({ type: "public-key", id: key.credentialId })),
            },
        };
    }

    /**
     * Approves the open review when the page's assertion proves a registered passkey signed this server's challenge, for
     * this review, as it is now.
     */
    public async approveWithPasskey(body: unknown): Promise<ApprovalResult> {
        return this.exclusive(async () => {
            const input = readBody(body, ["clientDataJSON", "authenticatorData", "signature"], {
                clientDataJSON: MAX_CLIENT_DATA,
                authenticatorData: MAX_AUTHENTICATOR_DATA,
                signature: MAX_SIGNATURE,
            });
            const challenge = this.challenges.take("approve", challengeFrom(input.clientDataJSON));
            if (challenge === undefined) throw new ApprovalError(403, "That approval is not current: the challenge was used, expired or never issued. Approve again.");

            const read = this.store.read();
            const credentialId = toBase64Url(input.id);
            const passkey = read.passkeys.find((key) => key.credentialId === credentialId);
            if (passkey === undefined) throw new ApprovalError(403, "That passkey is not registered here.");

            let signCount: number;
            try {
                ({ signCount } = verifyAssertion({
                    clientDataJSON: input.clientDataJSON,
                    authenticatorData: input.authenticatorData,
                    signature: input.signature,
                    expectedChallenge: challenge.value,
                    allowedOrigins: this.origins(),
                    key: publicKeyFromSpki(Buffer.from(passkey.publicKey, "base64")),
                    storedSignCount: passkey.signCount,
                }));
            } catch (error) {
                throw asApprovalError(error);
            }

            // The user approved what the page showed when the challenge was issued: if the review has moved on, they did not.
            const review = this.openReview();
            const bound = challenge.context;
            if (bound === undefined || bound.reviewId !== review.id || bound.diffHash !== diffHashOf(review)) {
                throw new ApprovalError(409, "The review changed while you were approving it. Look at it again, then approve.");
            }
            this.mutate(() => this.store.recordUse(passkey.fingerprint, signCount, new Date(this.now()).toISOString()));
            await this.host.approved(review, "passkey", passkey.fingerprint);
            return { ok: true, method: "passkey" };
        });
    }

    /**
     * The fallback: marks the review "approved in page", asks the user in Pi, and approves only on `y`. It is the same
     * rule as every other approval, with the page as the place the user pressed Approve.
     */
    public async approveInPage(): Promise<ApprovalResult> {
        return this.exclusive(async () => {
            const review = this.openReview();
            const diffHash = diffHashOf(review);
            await this.host.pageApproved(review);
            this.host.changed();
            const answer = await this.host.ask("Approve this review?", `${describe(review)}\nApprove was pressed in the review page. y approves it; n declines.`);

            const now = this.host.current();
            if (answer !== "yes") {
                await this.host.pageDeclined(review);
                this.host.changed();
                return { ok: false, message: answer === "no" ? "Not approved: you declined in Pi." : unavailable() };
            }
            if (now === undefined || now.id !== review.id || diffHashOf(now) !== diffHash || now.status !== "awaiting-review") {
                await this.host.pageDeclined(review);
                this.host.changed();
                return { ok: false, message: "The review changed while you were deciding, so it was not approved. Look at it again." };
            }
            await this.host.approved(now, "page-and-pi");
            return { ok: true, method: "page-and-pi" };
        });
    }

    // ---- helpers ---------------------------------------------------------------------------------------------------

    private openReview(): ReviewRecord {
        const review = this.host.current();
        if (review === undefined) throw new ApprovalError(409, "No review is open.");
        if (review.status !== "awaiting-review") {
            throw new ApprovalError(409, review.status === "approved" ? "This review is already approved." : "This review is not waiting for you: it is waiting for the agent, or it ended.");
        }
        return review;
    }

    private async exclusive<T>(run: () => Promise<T>): Promise<T> {
        if (this.busy) throw new ApprovalError(409, "Another approval is waiting for you in Pi. Answer it first.");
        this.busy = true;
        try {
            return await run();
        } finally {
            this.busy = false;
        }
    }

    /** A change to the passkey store: its refusal ("already registered", "unusable") is the user's to read. */
    private mutate<T>(change: () => T): T {
        try {
            return change();
        } catch (error) {
            if (error instanceof PasskeyStoreError) throw new ApprovalError(409, error.message);
            throw error;
        }
    }
}

function unavailable(): string {
    return "Pi cannot ask you right now (no interactive session), so nothing was approved. Run /code-review in Pi.";
}

function summary(key: { fingerprint: string; algorithm: "ES256" | "RS256"; createdAt: string; lastUsedAt?: string }): PasskeySummary {
    return {
        fingerprint: key.fingerprint,
        algorithm: key.algorithm,
        createdAt: key.createdAt,
        ...(key.lastUsedAt === undefined ? {} : { lastUsedAt: key.lastUsedAt }),
    };
}

function diffHashOf(review: ReviewRecord): string {
    return review.iterations.at(-1)?.diffHash ?? "";
}

/** One line about a review, for Pi's question. */
function describe(review: ReviewRecord): string {
    const files = filesOfDiff(review.iterations.at(-1)?.diff ?? "").length;
    const what = review.ticket ? `${review.ticket}, ` : "";
    return `Review ${review.id} (${what}${review.fileScope} scope, ${files} ${files === 1 ? "file" : "files"}, ${review.heads ?? `HEAD ${review.headSha.slice(0, 12)}`})`;
}

/** A failed WebAuthn check as the error the page shows; anything else is a bug and is thrown on. */
function asApprovalError(error: unknown): ApprovalError {
    if (error instanceof WebAuthnError) return new ApprovalError(403, `Not accepted: ${error.message}.`);
    throw error;
}

function challengeFrom(clientDataJSON: Buffer): Buffer {
    try {
        return challengeOf(clientDataJSON);
    } catch (error) {
        throw asApprovalError(error);
    }
}

/**
 * The browser's JSON: `{ id, response: { <fields> } }`, every value base64url and each field under its limit. Anything else
 * is a malformed request, which is not worth a challenge.
 */
function readBody<Field extends string>(
    body: unknown,
    fields: readonly Field[],
    limits: Record<Field, number>,
): { id: Buffer } & Record<Field, Buffer> {
    const record = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
    const response = record?.response;
    if (record === undefined || typeof response !== "object" || response === null) throw new ApprovalError(400, "The request is not a WebAuthn response.");
    try {
        const out: Record<string, Buffer> = { id: fromBase64Url(record.id, "the credential id") };
        if (out.id!.length === 0 || out.id!.length > 1023) throw new WebAuthnError("malformed", "the credential id has a bad length");
        for (const field of fields) {
            const bytes = fromBase64Url((response as Record<string, unknown>)[field], field);
            if (bytes.length === 0 || bytes.length > limits[field]) throw new WebAuthnError("malformed", `${field} has a bad length`);
            out[field] = bytes;
        }
        return out as { id: Buffer } & Record<Field, Buffer>;
    } catch (error) {
        if (error instanceof WebAuthnError) throw new ApprovalError(400, `The request is malformed: ${error.message}.`);
        throw error;
    }
}
