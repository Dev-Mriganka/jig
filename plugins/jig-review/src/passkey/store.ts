// The registered passkeys: `<agent folder>/jig-review/passkeys.json`, mode 0600. They are public keys, so reading them
// reveals nothing; what matters is that nothing the agent controls can add one. The file lives in Pi's agent folder, which
// the agent's shell does not write, and a key is added only after the user confirmed its fingerprint in Pi.
//
// When the file is read, a key is trusted only if it passes every check below. What fails is reported and ignored: this
// guards against damage and against a half-made edit, not against someone who can write the file and forges it whole,
// which is why the folder's protection is the real guard.
//
//   - The file as a whole is `unusable` when it is not a plain file of this user's, can be written by others, is too big,
//     is not JSON, or is not `{ "version": 1, "passkeys": [...] }`. No key is trusted, and nothing is written over it:
//     writing would destroy what a person may want to inspect, so the user must fix or delete it.
//   - A key entry is ignored when its public key does not load, is not ES256 or RS256, or when its stored fingerprint is not
//     the SHA-256 of that key. That fingerprint is what the user confirmed, so an entry with another key under it (or
//     with no `confirmedAt`) was never confirmed. A later write drops ignored entries.
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fingerprintOf, publicKeyFromSpki, WebAuthnError } from "./webauthn.ts";
import type { Algorithm } from "./webauthn.ts";

export interface StoredPasskey {
    /** base64url, as the browser names the credential. */
    credentialId: string;
    algorithm: Algorithm;
    /** SubjectPublicKeyInfo, DER, in base64. */
    publicKey: string;
    /** SHA-256 of the public key, in hex: what the user confirmed. */
    fingerprint: string;
    signCount: number;
    createdAt: string;
    /** When the user confirmed the fingerprint in Pi. */
    confirmedAt: string;
    lastUsedAt?: string;
}

export interface PasskeyRead {
    /** Keys that passed every check. */
    passkeys: StoredPasskey[];
    /** One line for each thing that was ignored. */
    problems: string[];
    /** Why the whole file is not trusted, when it is not. Then `passkeys` is empty. */
    unusable?: string;
}

export class PasskeyStoreError extends Error {}

const MAX_BYTES = 1024 * 1024;
const MAX_PASSKEYS = 10;
const HEX64 = /^[0-9a-f]{64}$/;

export class PasskeyStore {
    public readonly file: string;

    public constructor(file: string) {
        this.file = file;
    }

    /** Reads the file afresh every time: another Pi may have changed it. */
    public read(): PasskeyRead {
        let text: string;
        try {
            const stat = lstatSync(this.file);
            if (!stat.isFile()) return unusable("is not a plain file (a link or a folder)");
            if ((stat.mode & 0o022) !== 0)
                return unusable("can be written by other users: run chmod 600 on it after checking it");
            if (typeof process.getuid === "function" && stat.uid !== process.getuid())
                return unusable("belongs to another user");
            if (stat.size > MAX_BYTES) return unusable("is too big");
            text = readFileSync(this.file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { passkeys: [], problems: [] };
            return unusable("cannot be read");
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return unusable("is not valid JSON");
        }
        const list = (parsed as { version?: unknown; passkeys?: unknown } | null)?.passkeys;
        if ((parsed as { version?: unknown } | null)?.version !== 1 || !Array.isArray(list)) {
            return unusable('is not { "version": 1, "passkeys": [...] }');
        }
        const passkeys: StoredPasskey[] = [];
        const problems: string[] = [];
        list.forEach((entry, index) => {
            const result = checkEntry(entry);
            if (typeof result === "string") problems.push(`passkeys.json: entry ${index + 1} ignored: ${result}`);
            else if (
                passkeys.some(
                    (key) => key.credentialId === result.credentialId || key.fingerprint === result.fingerprint,
                )
            ) {
                problems.push(`passkeys.json: entry ${index + 1} ignored: the same key is listed twice`);
            } else passkeys.push(result);
        });
        return { passkeys, problems };
    }

    /** Adds a confirmed key. Refuses when the file is unusable, the key is already there, or ten keys are. */
    public add(passkey: StoredPasskey): void {
        const current = this.writable();
        if (
            current.some((key) => key.credentialId === passkey.credentialId || key.fingerprint === passkey.fingerprint)
        ) {
            throw new PasskeyStoreError("this passkey is already registered");
        }
        if (current.length >= MAX_PASSKEYS)
            throw new PasskeyStoreError(`at most ${MAX_PASSKEYS} passkeys can be registered: remove one first`);
        this.write([...current, passkey]);
    }

    /** False when no key has this fingerprint. */
    public remove(fingerprint: string): boolean {
        const current = this.writable();
        const kept = current.filter((key) => key.fingerprint !== fingerprint);
        if (kept.length === current.length) return false;
        this.write(kept);
        return true;
    }

    /** Stores the counter an assertion reported, and when it was used. */
    public recordUse(fingerprint: string, signCount: number, at: string): void {
        const current = this.writable();
        const key = current.find((entry) => entry.fingerprint === fingerprint);
        if (key === undefined) throw new PasskeyStoreError("the passkey is no longer registered");
        key.signCount = signCount;
        key.lastUsedAt = at;
        this.write(current);
    }

    private writable(): StoredPasskey[] {
        const read = this.read();
        if (read.unusable !== undefined)
            throw new PasskeyStoreError(`passkeys.json ${read.unusable}: fix or delete ${this.file}`);
        return read.passkeys;
    }

    /** Whole-file write: a new private file renamed over the old, so a reader sees one or the other. */
    private write(passkeys: StoredPasskey[]): void {
        const dir = path.dirname(this.file);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        try {
            writeFileSync(temporary, `${JSON.stringify({ version: 1, passkeys }, null, 2)}\n`, {
                flag: "wx",
                mode: 0o600,
            });
            renameSync(temporary, this.file);
        } catch (error) {
            try {
                unlinkSync(temporary);
            } catch {
                // nothing was written
            }
            throw error;
        }
    }
}

function unusable(reason: string): PasskeyRead {
    return { passkeys: [], problems: [], unusable: reason };
}

/** The entry as a trusted key, or the reason it is not one. */
function checkEntry(entry: unknown): StoredPasskey | string {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "it is not an object";
    const e = entry as Record<string, unknown>;
    if (typeof e.credentialId !== "string" || !/^[A-Za-z0-9_-]{1,1400}$/.test(e.credentialId))
        return "its credential id is not valid";
    if (typeof e.publicKey !== "string" || e.publicKey === "") return "it has no public key";
    if (typeof e.fingerprint !== "string" || !HEX64.test(e.fingerprint)) return "it has no fingerprint";
    if (typeof e.confirmedAt !== "string" || Number.isNaN(Date.parse(e.confirmedAt)))
        return "it was never confirmed (no confirmedAt)";
    if (typeof e.createdAt !== "string" || Number.isNaN(Date.parse(e.createdAt))) return "it has no creation time";
    if (!Number.isInteger(e.signCount) || (e.signCount as number) < 0 || (e.signCount as number) > 0xffffffff)
        return "its signature counter is not valid";
    if (e.lastUsedAt !== undefined && (typeof e.lastUsedAt !== "string" || Number.isNaN(Date.parse(e.lastUsedAt))))
        return "its last-used time is not valid";
    const spki = Buffer.from(e.publicKey, "base64");
    let algorithm: Algorithm;
    try {
        algorithm = publicKeyFromSpki(spki).algorithm;
    } catch (error) {
        return error instanceof WebAuthnError ? error.message : "its public key does not load";
    }
    // The fingerprint is what the user confirmed. A different key under it was never confirmed.
    if (fingerprintOf(spki) !== e.fingerprint)
        return "its fingerprint is not the fingerprint of its key, so this key was never confirmed";
    if (e.algorithm !== algorithm) return "its algorithm is not the key's";
    return {
        credentialId: e.credentialId,
        algorithm,
        publicKey: e.publicKey,
        fingerprint: e.fingerprint,
        signCount: e.signCount as number,
        createdAt: e.createdAt,
        confirmedAt: e.confirmedAt,
        ...(typeof e.lastUsedAt === "string" ? { lastUsedAt: e.lastUsedAt } : {}),
    };
}
