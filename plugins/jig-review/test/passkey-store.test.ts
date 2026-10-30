// The passkey store and what it does with a file that is wrong. The decision, in short: a key is trusted only when its stored
// fingerprint (what the user confirmed) is the SHA-256 of its public key; an entry that fails is ignored and reported; a file
// that is unreadable, loose or not ours is not trusted at all and is never written over.
import assert from "node:assert/strict";
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { PasskeyStore, PasskeyStoreError } from "../src/passkey/store.ts";
import type { StoredPasskey } from "../src/passkey/store.ts";
import { fingerprintOf, toBase64Url } from "../src/passkey/webauthn.ts";
import { FakeAuthenticator } from "./support/authenticator.ts";

let dir = "";
let file = "";
let store: PasskeyStore;

beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "jig-review-passkeys-"));
    file = path.join(dir, "jig-review", "passkeys.json");
    store = new PasskeyStore(file);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stored(auth = new FakeAuthenticator(), overrides: Partial<StoredPasskey> = {}): StoredPasskey {
    const spki = auth.publicKey.export({ type: "spki", format: "der" });
    return {
        credentialId: toBase64Url(auth.credentialId),
        algorithm: auth.algorithm,
        publicKey: spki.toString("base64"),
        fingerprint: fingerprintOf(spki),
        signCount: 0,
        createdAt: "2026-10-30T10:00:00.000Z",
        confirmedAt: "2026-10-30T10:00:05.000Z",
        ...overrides,
    };
}

/** Writes a file as someone else might have, mode 0600 unless told otherwise. */
function plant(content: unknown, mode = 0o600): void {
    rmSync(file, { force: true });
    store.add(stored()); // creates the folder
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    chmodSync(file, mode);
}

test("no file: no passkeys, no problem", () => {
    assert.deepEqual(store.read(), { passkeys: [], problems: [] });
});

test("a key is added to a private file in a private folder, and read back", () => {
    const key = stored();
    store.add(key);
    assert.deepEqual(store.read().passkeys, [key]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o077, 0, "the folder is the user's alone");
    assert.deepEqual(readdirSync(path.dirname(file)), ["passkeys.json"], "no temporary file is left");
});

test("the same key cannot be added twice, and at most ten are kept", () => {
    const auth = new FakeAuthenticator();
    store.add(stored(auth));
    assert.throws(() => store.add(stored(auth)), /already registered/);
    for (let i = 0; i < 9; i++) store.add(stored());
    assert.throws(
        () => store.add(stored()),
        (error) => error instanceof PasskeyStoreError && /at most 10/.test(error.message),
    );
});

test("removing a key by its fingerprint, and recording a use", () => {
    const a = stored();
    const b = stored();
    store.add(a);
    store.add(b);
    store.recordUse(a.fingerprint, 7, "2026-10-30T11:00:00.000Z");
    const [first] = store.read().passkeys;
    assert.equal(first?.signCount, 7);
    assert.equal(first?.lastUsedAt, "2026-10-30T11:00:00.000Z");
    assert.equal(store.remove(a.fingerprint), true);
    assert.deepEqual(
        store.read().passkeys.map((key) => key.fingerprint),
        [b.fingerprint],
    );
    assert.equal(store.remove(a.fingerprint), false, "already gone");
    assert.throws(() => store.recordUse(a.fingerprint, 1, "x"), /no longer registered/);
});

// ---- a file that was tampered with -------------------------------------------------------------------------------------

test("a key whose fingerprint is not its key's was never confirmed: it is ignored, and reported", () => {
    const real = stored();
    const swapped = stored(new FakeAuthenticator(), { fingerprint: real.fingerprint });
    plant({ version: 1, passkeys: [swapped, real] });
    const read = store.read();
    assert.deepEqual(
        read.passkeys,
        [real],
        "the entry that carries the real fingerprint with another key is not trusted",
    );
    assert.equal(read.unusable, undefined, "the file itself is fine");
    assert.match(
        read.problems.join("\n"),
        /entry 1 ignored: its fingerprint is not the fingerprint of its key, so this key was never confirmed/,
    );
});

test("an entry with no confirmation time, a weak key, a wrong algorithm or a damaged field is ignored; the others stay", () => {
    const good = stored();
    const unconfirmed = stored(new FakeAuthenticator(), { confirmedAt: undefined as never });
    const wrongAlgorithm = stored(new FakeAuthenticator("ES256"), { algorithm: "RS256" });
    const notAKey = stored(new FakeAuthenticator(), { publicKey: Buffer.from("garbage").toString("base64") });
    const badCounter = stored(new FakeAuthenticator(), { signCount: -1 });
    const badId = stored(new FakeAuthenticator(), { credentialId: "has spaces" });
    plant({ version: 1, passkeys: [unconfirmed, wrongAlgorithm, notAKey, badCounter, badId, 42, good] });
    const read = store.read();
    assert.deepEqual(read.passkeys, [good]);
    assert.equal(read.problems.length, 6);
    assert.match(read.problems[0]!, /entry 1 ignored: it was never confirmed/);
    assert.match(read.problems[1]!, /entry 2 ignored: its algorithm is not the key's/);
    assert.match(read.problems[2]!, /entry 3 ignored: the stored key is not a valid public key/);
    assert.match(read.problems[5]!, /entry 6 ignored: it is not an object/);
});

test("a duplicate entry is ignored", () => {
    const key = stored();
    plant({ version: 1, passkeys: [key, key] });
    assert.equal(store.read().passkeys.length, 1);
    assert.match(store.read().problems[0]!, /listed twice/);
});

test("ignored entries are dropped by the next write, and the good ones are kept", () => {
    const good = stored();
    plant({ version: 1, passkeys: [stored(new FakeAuthenticator(), { confirmedAt: undefined as never }), good] });
    const added = stored();
    store.add(added);
    assert.deepEqual(
        JSON.parse(readFileSync(file, "utf8")).passkeys.map((key: StoredPasskey) => key.fingerprint),
        [good.fingerprint, added.fingerprint],
    );
});

test("a file that cannot be parsed is not trusted, and nothing is written over it", () => {
    plant("{ half written");
    assert.equal(store.read().unusable, "is not valid JSON");
    assert.deepEqual(store.read().passkeys, []);
    assert.throws(() => store.add(stored()), /passkeys\.json is not valid JSON: fix or delete/);
    assert.throws(() => store.remove("a".repeat(64)), PasskeyStoreError);
    assert.equal(readFileSync(file, "utf8"), "{ half written", "left as it was, for a person to look at");
});

test("a file of the wrong shape or version is not trusted", () => {
    for (const content of [[], { version: 2, passkeys: [] }, { passkeys: [] }, { version: 1 }, "null", "42"]) {
        plant(content);
        assert.match(store.read().unusable ?? "", /is not \{ "version": 1/, JSON.stringify(content));
    }
});

test("a file that others can write is not trusted: it may have been changed", () => {
    const key = stored();
    plant({ version: 1, passkeys: [key] }, 0o666);
    assert.match(store.read().unusable ?? "", /can be written by other users/);
    assert.deepEqual(store.read().passkeys, []);
    chmodSync(file, 0o620);
    assert.match(store.read().unusable ?? "", /can be written by other users/, "group write too");
    chmodSync(file, 0o644);
    assert.deepEqual(store.read().passkeys, [key], "readable by others is harmless: they are public keys");
});

test("a link in place of the file is not followed", () => {
    store.add(stored());
    const real = path.join(dir, "elsewhere.json");
    writeFileSync(real, JSON.stringify({ version: 1, passkeys: [stored()] }), { mode: 0o600 });
    rmSync(file);
    symlinkSync(real, file);
    assert.match(store.read().unusable ?? "", /not a plain file/);
});

test("a file that is too big is not trusted", () => {
    plant({ version: 1, passkeys: [], padding: "x".repeat(1024 * 1024 + 1) });
    assert.equal(store.read().unusable, "is too big");
});
