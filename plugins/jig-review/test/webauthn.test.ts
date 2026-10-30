// The WebAuthn checks, one at a time, against a fake authenticator that can get each field wrong.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
    challengeOf,
    fingerprintOf,
    formatFingerprint,
    fromBase64Url,
    parseAuthenticatorData,
    publicKeyFromCose,
    publicKeyFromSpki,
    toBase64Url,
    verifyAssertion,
    verifyRegistration,
    WebAuthnError,
} from "../src/passkey/webauthn.ts";
import type { WebAuthnFailure } from "../src/passkey/webauthn.ts";
import { FakeAuthenticator } from "./support/authenticator.ts";
import type { Created, Faults } from "./support/authenticator.ts";

const ORIGIN = "http://localhost:4321";
const ALLOWED = [ORIGIN, "http://127.0.0.1:4321"];

/** The failure a call ends with, so a test names which check refused. */
function failsWith(code: WebAuthnFailure, run: () => unknown): void {
    assert.throws(run, (error) => error instanceof WebAuthnError && error.code === code, `expected a ${code} failure`);
}

function register(auth: FakeAuthenticator, faults: Faults = {}) {
    const challenge = randomBytes(32);
    const created = auth.create({ challenge, origin: ORIGIN }, faults);
    return { challenge, created, input: registrationInput(created, challenge) };
}

function registrationInput(created: Created, challenge: Buffer) {
    return {
        clientDataJSON: fromBase64Url(created.response.clientDataJSON),
        attestationObject: fromBase64Url(created.response.attestationObject),
        expectedChallenge: challenge,
        allowedOrigins: ALLOWED,
    };
}

/** An authenticator that is registered, and what the server would store about it. */
function registered(algorithm: "ES256" | "RS256" = "ES256") {
    const auth = new FakeAuthenticator(algorithm);
    const key = verifyRegistration(register(auth).input).key;
    return { auth, key };
}

function assertion(
    auth: FakeAuthenticator,
    key: ReturnType<typeof registered>["key"],
    faults: Faults = {},
    storedSignCount = 0,
    expected?: Buffer,
) {
    const challenge = randomBytes(32);
    const asserted = auth.get({ challenge, origin: ORIGIN }, faults);
    return () =>
        verifyAssertion({
            clientDataJSON: fromBase64Url(asserted.response.clientDataJSON),
            authenticatorData: fromBase64Url(asserted.response.authenticatorData),
            signature: fromBase64Url(asserted.response.signature),
            expectedChallenge: expected ?? challenge,
            allowedOrigins: ALLOWED,
            key,
            storedSignCount,
        });
}

// ---- registration ------------------------------------------------------------------------------------------------------

for (const algorithm of ["ES256", "RS256"] as const) {
    test(`registration: a ${algorithm} credential gives its id, its key and its fingerprint`, () => {
        const auth = new FakeAuthenticator(algorithm);
        const { input } = register(auth);
        const result = verifyRegistration(input);
        assert.deepEqual(result.credentialId, auth.credentialId);
        assert.equal(result.key.algorithm, algorithm);
        assert.equal(result.signCount, 0);
        assert.deepEqual(result.key.spki, auth.publicKey.export({ type: "spki", format: "der" }));
        assert.equal(fingerprintOf(result.key.spki), createHash("sha256").update(result.key.spki).digest("hex"));
    });
}

test("registration: a wrong challenge, a wrong origin and the wrong ceremony are each refused", () => {
    const auth = new FakeAuthenticator();
    failsWith("challenge", () => verifyRegistration(register(auth, { challenge: randomBytes(32) }).input));
    failsWith("origin", () => verifyRegistration(register(auth, { origin: "http://localhost:9999" }).input));
    failsWith("origin", () => verifyRegistration(register(auth, { origin: "https://evil.example" }).input));
    failsWith("origin", () =>
        verifyRegistration(register(auth, { origin: "http://localhost.evil.example:4321" }).input),
    );
    failsWith("origin", () => verifyRegistration(register(auth, { crossOrigin: true }).input));
    failsWith("type", () => verifyRegistration(register(auth, { type: "webauthn.get" }).input));
});

test("registration: a wrong relying party id, and a user who was not present or not verified, are refused", () => {
    const auth = new FakeAuthenticator();
    failsWith("rp-id", () => verifyRegistration(register(auth, { rpId: "example.com" }).input));
    failsWith("rp-id", () => verifyRegistration(register(auth, { rpId: "127.0.0.1" }).input));
    failsWith("user-present", () => verifyRegistration(register(auth, { userPresent: false }).input));
    failsWith("user-verified", () => verifyRegistration(register(auth, { userVerified: false }).input));
});

test("registration: authenticatorData with trailing bytes, or with no credential, is refused", () => {
    const auth = new FakeAuthenticator();
    failsWith("malformed", () => verifyRegistration(register(auth, { trailing: Buffer.from("extra") }).input));
    // An assertion's authenticatorData carries no credential: it is not an attestation.
    const challenge = randomBytes(32);
    const asserted = auth.get({ challenge, origin: ORIGIN });
    failsWith("type", () =>
        verifyRegistration({
            clientDataJSON: fromBase64Url(asserted.response.clientDataJSON),
            attestationObject: Buffer.from("x"),
            expectedChallenge: challenge,
            allowedOrigins: ALLOWED,
        }),
    );
});

test("registration: only P-256 and RSA of 2048 bits or more are accepted", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const jwk = p384.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = {
        map: [
            [1, 2],
            [3, -7],
            [-1, 2],
            [-2, Buffer.from(jwk.x, "base64url")],
            [-3, Buffer.from(jwk.y, "base64url")],
        ],
    } as never;
    failsWith("key", () => verifyRegistration(registerWithCose(new FakeAuthenticator(), cose)));

    // A 1024-bit RSA key signs fine, but is too short to trust.
    const weak = new FakeAuthenticator("RS256", { modulusLength: 1024 });
    failsWith("key", () => verifyRegistration(register(weak).input));
    // EdDSA (-8) is not offered by the page, so a credential with it is not accepted.
    const eddsa = {
        map: [
            [1, 1],
            [3, -8],
            [-1, 6],
            [-2, Buffer.alloc(32, 1)],
        ],
    } as never;
    failsWith("key", () => verifyRegistration(registerWithCose(new FakeAuthenticator(), eddsa)));
    // An ES256 label on an RSA key does not turn it into one.
    const mislabelled = {
        map: [
            [1, 3],
            [3, -7],
            [-1, Buffer.alloc(256, 1)],
            [-2, Buffer.from([1, 0, 1])],
        ],
    } as never;
    failsWith("key", () => verifyRegistration(registerWithCose(new FakeAuthenticator(), mislabelled)));
});

function registerWithCose(auth: FakeAuthenticator, cose: never) {
    const challenge = randomBytes(32);
    return registrationInput(auth.create({ challenge, origin: ORIGIN }, {}, cose), challenge);
}

test("registration: a point that is not on the curve is refused", () => {
    const good = new FakeAuthenticator().publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const y = Buffer.from(good.y, "base64url");
    y[31]! ^= 0xff;
    const off = {
        map: [
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, Buffer.from(good.x, "base64url")],
            [-3, y],
        ],
    } as never;
    failsWith("key", () => verifyRegistration(registerWithCose(new FakeAuthenticator(), off)));
});

test("registration: a damaged attestation is refused, not guessed at", () => {
    const auth = new FakeAuthenticator();
    const { created, challenge } = register(auth);
    const bytes = fromBase64Url(created.response.attestationObject);
    for (const damaged of [
        bytes.subarray(0, bytes.length - 3),
        Buffer.concat([bytes, Buffer.from([0])]),
        Buffer.from([0xa0]),
        Buffer.from([0x9f, 0xff]),
        Buffer.alloc(0),
    ]) {
        assert.throws(
            () => verifyRegistration({ ...registrationInput(created, challenge), attestationObject: damaged }),
            WebAuthnError,
        );
    }
});

// ---- assertion ---------------------------------------------------------------------------------------------------------

for (const algorithm of ["ES256", "RS256"] as const) {
    test(`assertion: a ${algorithm} signature over the issued challenge is accepted, with the counter`, () => {
        const { auth, key } = registered(algorithm);
        assert.deepEqual(assertion(auth, key)(), { signCount: 1 });
        assert.deepEqual(assertion(auth, key, {}, 1)(), { signCount: 2 });
    });
}

test("assertion: a wrong challenge is refused, and a challenge from another ceremony too", () => {
    const { auth, key } = registered();
    failsWith("challenge", assertion(auth, key, { challenge: randomBytes(32) }));
    failsWith("challenge", assertion(auth, key, {}, 0, randomBytes(32)));
    failsWith("malformed", assertion(auth, key, { challenge: "not base64url!" }));
});

test("assertion: the page's origin must be this server's, as localhost or 127.0.0.1", () => {
    const { auth, key } = registered();
    assert.ok(assertion(auth, key, { origin: "http://127.0.0.1:4321" })());
    failsWith("origin", assertion(auth, key, { origin: "http://localhost:4322" }));
    failsWith("origin", assertion(auth, key, { origin: "https://localhost:4321" }));
    failsWith("origin", assertion(auth, key, { origin: "http://evil.example" }));
    failsWith("origin", assertion(auth, key, { crossOrigin: true }));
});

test("assertion: the ceremony type, the relying party id hash and the user's presence and verification are checked", () => {
    const { auth, key } = registered();
    failsWith("type", assertion(auth, key, { type: "webauthn.create" }));
    failsWith("rp-id", assertion(auth, key, { rpId: "example.com" }));
    failsWith("user-present", assertion(auth, key, { userPresent: false }));
    failsWith("user-verified", assertion(auth, key, { userVerified: false }));
    failsWith("user-present", assertion(auth, key, { userPresent: false, userVerified: false }));
});

test("assertion: a bad signature, a signature by another key and trailing data are refused", () => {
    const { auth, key } = registered();
    failsWith("signature", assertion(auth, key, { badSignature: true }));
    failsWith(
        "signature",
        assertion(auth, key, { signWith: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey }),
    );
    // The signature covers authenticatorData: bytes added to it after signing do not verify (or do not parse).
    assert.throws(assertion(auth, key, { trailing: Buffer.from("x") }), WebAuthnError);
    // The signature covers clientDataJSON: another challenge there, signed for the first, does not verify.
    const other = registered("RS256");
    failsWith("signature", assertion(auth, other.key));
});

test("assertion: the signature counter must go up when either side counts, and may stay 0 when neither does", () => {
    const { auth, key } = registered();
    assert.deepEqual(assertion(auth, key, { signCount: 5 }, 4)(), { signCount: 5 });
    failsWith("sign-count", assertion(auth, key, { signCount: 3 }, 4));
    failsWith("sign-count", assertion(auth, key, { signCount: 4 }, 4));
    failsWith("sign-count", assertion(auth, key, { signCount: 0 }, 4));
    assert.deepEqual(assertion(auth, key, { signCount: 2 }, 0)(), { signCount: 2 }, "up from a stored 0 is fine");
});

test("assertion: an authenticator with no counter reports 0 each time and is accepted", () => {
    const auth = new FakeAuthenticator("ES256", { counting: false });
    const key = verifyRegistration(register(auth).input).key;
    assert.deepEqual(assertion(auth, key)(), { signCount: 0 });
    assert.deepEqual(assertion(auth, key, {}, 0)(), { signCount: 0 });
});

// ---- the smaller parts -------------------------------------------------------------------------------------------------

test("a stored key loads under the same rules as a registered one", () => {
    const { key } = registered();
    assert.equal(publicKeyFromSpki(key.spki).algorithm, "ES256");
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" });
    failsWith("key", () => publicKeyFromSpki(weak));
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({
        type: "spki",
        format: "der",
    });
    failsWith("key", () => publicKeyFromSpki(p384));
    failsWith("key", () => publicKeyFromSpki(Buffer.from("not a key")));
    failsWith("key", () => publicKeyFromCose("nope" as never));
});

test("authenticator data is exact: too short, a credential cut short, and a bad credential id are refused", () => {
    failsWith("malformed", () => parseAuthenticatorData(Buffer.alloc(36)));
    const header = Buffer.concat([randomBytes(32), Buffer.from([0x45]), Buffer.alloc(4)]);
    failsWith("malformed", () => parseAuthenticatorData(header));
    failsWith("malformed", () =>
        parseAuthenticatorData(Buffer.concat([header, Buffer.alloc(16), Buffer.from([0, 0])])),
    );
    failsWith("malformed", () =>
        parseAuthenticatorData(Buffer.concat([header, Buffer.alloc(16), Buffer.from([0xff, 0xff])])),
    );
});

test("base64url is strict, and a fingerprint is shown in groups", () => {
    assert.equal(toBase64Url(Buffer.from([251, 255])), "-_8");
    assert.deepEqual(fromBase64Url("-_8"), Buffer.from([251, 255]));
    for (const bad of ["a=", "a b", "a+b", "a/b", 5, undefined]) failsWith("malformed", () => fromBase64Url(bad));
    assert.equal(
        formatFingerprint("0123456789abcdef".repeat(4)),
        "01234567 89abcdef 01234567 89abcdef 01234567 89abcdef 01234567 89abcdef",
    );
    failsWith("malformed", () => challengeOf(Buffer.from("not json")));
    failsWith("malformed", () => challengeOf(Buffer.from("[]")));
});
