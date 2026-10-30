// The challenges the server has issued and not yet seen answered. A challenge is 32 random bytes, good for one answer
// and for two minutes, and it belongs to one purpose: a challenge issued for a registration cannot approve a review.
import { randomBytes } from "node:crypto";

export type ChallengePurpose = "register" | "approve";

export interface IssuedChallenge<Context> {
    /** The 32 bytes the browser must sign or echo. */
    value: Buffer;
    purpose: ChallengePurpose;
    expiresAt: number;
    /** What the challenge was issued for, so an answer cannot be used for something else. */
    context: Context;
}

export const CHALLENGE_BYTES = 32;
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;
/** A page asking again and again must not grow this without bound. */
const MAX_OUTSTANDING = 16;

export class ChallengeBook<Context> {
    private readonly issued = new Map<string, IssuedChallenge<Context>>();
    private readonly now: () => number;
    private readonly ttlMs: number;

    public constructor(now: () => number = Date.now, ttlMs: number = CHALLENGE_TTL_MS) {
        this.now = now;
        this.ttlMs = ttlMs;
    }

    public issue(purpose: ChallengePurpose, context: Context): IssuedChallenge<Context> {
        this.forgetExpired();
        while (this.issued.size >= MAX_OUTSTANDING) {
            const oldest = this.issued.keys().next().value;
            if (oldest === undefined) break;
            this.issued.delete(oldest);
        }
        const challenge: IssuedChallenge<Context> = {
            value: randomBytes(CHALLENGE_BYTES),
            purpose,
            expiresAt: this.now() + this.ttlMs,
            context,
        };
        this.issued.set(challenge.value.toString("base64url"), challenge);
        return challenge;
    }

    /**
     * The challenge an answer names, which is then used up whatever the outcome: a wrong guess burns the challenge it hit.
     * Undefined when it was never issued, was already used, has expired, or was issued for another purpose.
     */
    public take(purpose: ChallengePurpose, value: Buffer): IssuedChallenge<Context> | undefined {
        const key = value.toString("base64url");
        const challenge = this.issued.get(key);
        if (challenge === undefined) return undefined;
        this.issued.delete(key);
        if (challenge.purpose !== purpose || challenge.expiresAt <= this.now()) return undefined;
        return challenge;
    }

    public clear(): void {
        this.issued.clear();
    }

    public get size(): number {
        return this.issued.size;
    }

    private forgetExpired(): void {
        const now = this.now();
        for (const [key, challenge] of this.issued) {
            if (challenge.expiresAt <= now) this.issued.delete(key);
        }
    }
}
