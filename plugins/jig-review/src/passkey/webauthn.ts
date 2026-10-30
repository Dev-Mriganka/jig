// WebAuthn for one purpose: checking, on this machine, that a person with a registered authenticator just approved a
// review. It uses node:crypto and nothing else, so what runs here is short enough to read.
//
// Two checks live here, each a pure function of what the browser sent:
//   - verifyRegistration: an attestation (`navigator.credentials.create`) -> the new credential's public key;
//   - verifyAssertion: an assertion (`navigator.credentials.get`) -> proof that the registered key signed our challenge.
// Neither trusts the authenticator's make or model, so the attestation statement is not examined (the page asks for
// attestation "none"). What makes a key trusted is that the user confirmed its fingerprint in Pi (see approval.ts).
//
// What is checked, as the WebAuthn specification (level 2, sections 7.1 and 7.2) lists it: the ceremony type, the
// challenge, the origin, that the page was not framed from another origin, the hash of the relying party id, that the user
// was present and verified, and, for an assertion, the signature over authenticatorData + SHA-256(clientDataJSON) and the
// signature counter.
import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { decodeCbor, CborError } from "./cbor.ts";
import type { Cbor } from "./cbor.ts";

/** The relying party id. A browser accepts an IP address as neither an id nor a domain, so the page is opened at `localhost`. */
export const RP_ID = "localhost";

export type Algorithm = "ES256" | "RS256";

/** Why a check failed. The page shows the message; the code is for tests and for the record in Pi. */
export type WebAuthnFailure =
    | "malformed"
    | "type"
    | "challenge"
    | "origin"
    | "rp-id"
    | "user-present"
    | "user-verified"
    | "key"
    | "signature"
    | "sign-count";

export class WebAuthnError extends Error {
    public readonly code: WebAuthnFailure;
    public constructor(code: WebAuthnFailure, message: string) {
        super(message);
        this.code = code;
    }
}

// ---- base64url ---------------------------------------------------------------------------------------------------------

/** base64url without padding, as WebAuthn and the browser's JSON use it. */
export function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

/** The bytes of a base64url string. Anything but base64url characters is refused, not skipped. */
export function fromBase64Url(text: unknown, what = "value"): Buffer {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new WebAuthnError("malformed", `${what} is not base64url`);
    return Buffer.from(text, "base64url");
}

const sha256 = (data: Uint8Array): Buffer => createHash("sha256").update(data).digest();

/** SHA-256 of the public key's SubjectPublicKeyInfo, as 64 lowercase hex digits: the name of a key in Pi and in the page. */
export function fingerprintOf(spki: Uint8Array): string {
    return sha256(spki).toString("hex");
}

/** A fingerprint in groups of eight digits, for a person to compare. */
export function formatFingerprint(fingerprint: string): string {
    return (fingerprint.match(/.{1,8}/g) ?? []).join(" ");
}

// ---- authenticator data ------------------------------------------------------------------------------------------------

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export interface AuthenticatorData {
    rpIdHash: Buffer;
    userPresent: boolean;
    userVerified: boolean;
    signCount: number;
    /** Present when the authenticator attached a credential (registration). */
    credential?: { id: Buffer; publicKey: Cbor };
}

/** Parses `authData`. Bytes it does not account for are an error. */
export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
    if (data.length < 37) throw new WebAuthnError("malformed", "authenticator data is too short");
    const flags = data[32]!;
    const parsed: AuthenticatorData = {
        rpIdHash: data.subarray(0, 32),
        userPresent: (flags & FLAG_UP) !== 0,
        userVerified: (flags & FLAG_UV) !== 0,
        signCount: data.readUInt32BE(33),
    };
    let end = 37;
    if ((flags & FLAG_AT) !== 0) {
        if (data.length < end + 18) throw new WebAuthnError("malformed", "authenticator data has no credential");
        const idLength = data.readUInt16BE(end + 16);
        const idStart = end + 18;
        if (idLength === 0 || idLength > 1023 || data.length < idStart + idLength) {
            throw new WebAuthnError("malformed", "authenticator data has a bad credential id");
        }
        try {
            const key = decodeCbor(data, idStart + idLength);
            parsed.credential = { id: data.subarray(idStart, idStart + idLength), publicKey: key.value };
            end = key.end;
        } catch (error) {
            if (error instanceof CborError) throw new WebAuthnError("malformed", `credential key: ${error.message}`);
            throw error;
        }
    }
    if ((flags & FLAG_ED) !== 0) {
        try {
            end = decodeCbor(data, end).end;
        } catch (error) {
            if (error instanceof CborError) throw new WebAuthnError("malformed", `extensions: ${error.message}`);
            throw error;
        }
    }
    if (end !== data.length) throw new WebAuthnError("malformed", "authenticator data has trailing bytes");
    return parsed;
}

// ---- keys --------------------------------------------------------------------------------------------------------------

export interface PublicKey {
    algorithm: Algorithm;
    /** SubjectPublicKeyInfo, DER: what the store keeps. */
    spki: Buffer;
    key: KeyObject;
}

const COSE_KTY = 1;
const COSE_ALG = 3;
const KTY_EC2 = 2;
const KTY_RSA = 3;
const ALG_ES256 = -7;
const ALG_RS256 = -257;
const CRV_P256 = 1;

function field(map: Map<number | string, Cbor>, key: number, what: string): Uint8Array {
    const value = map.get(key);
    if (!(value instanceof Uint8Array)) throw new WebAuthnError("key", `the key has no ${what}`);
    return value;
}

/** A COSE key from an attestation: EC2 P-256 (ES256) or RSA of at least 2048 bits (RS256), as a node key. */
export function publicKeyFromCose(cose: Cbor): PublicKey {
    if (!(cose instanceof Map)) throw new WebAuthnError("key", "the credential key is not a COSE map");
    const kty = cose.get(COSE_KTY);
    const alg = cose.get(COSE_ALG);
    let jwk: { kty: string; crv?: string; x?: string; y?: string; n?: string; e?: string };
    if (kty === KTY_EC2 && alg === ALG_ES256) {
        if (cose.get(-1) !== CRV_P256) throw new WebAuthnError("key", "the key is not on curve P-256");
        const x = field(cose, -2, "x coordinate");
        const y = field(cose, -3, "y coordinate");
        if (x.length !== 32 || y.length !== 32) throw new WebAuthnError("key", "a P-256 coordinate is not 32 bytes");
        jwk = { kty: "EC", crv: "P-256", x: toBase64Url(x), y: toBase64Url(y) };
    } else if (kty === KTY_RSA && alg === ALG_RS256) {
        const n = field(cose, -1, "modulus");
        const e = field(cose, -2, "exponent");
        jwk = { kty: "RSA", n: toBase64Url(n), e: toBase64Url(e) };
    } else {
        throw new WebAuthnError("key", "only ES256 (P-256) and RS256 (RSA) keys are accepted");
    }
    let key: KeyObject;
    try {
        // Node checks that an EC point is on its curve when it loads the key.
        key = createPublicKey({ key: jwk, format: "jwk" });
    } catch {
        throw new WebAuthnError("key", "the credential key is not a valid public key");
    }
    return checkedKey(key);
}

/** A key from the store: the same rules, so a stored key is never weaker than a registered one. */
export function publicKeyFromSpki(spki: Uint8Array): PublicKey {
    let key: KeyObject;
    try {
        key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    } catch {
        throw new WebAuthnError("key", "the stored key is not a valid public key");
    }
    return checkedKey(key);
}

function checkedKey(key: KeyObject): PublicKey {
    const details = key.asymmetricKeyDetails;
    let algorithm: Algorithm;
    if (key.asymmetricKeyType === "ec" && details?.namedCurve === "prime256v1") {
        algorithm = "ES256";
    } else if (key.asymmetricKeyType === "rsa") {
        const exponent = details?.publicExponent ?? 0n;
        if ((details?.modulusLength ?? 0) < 2048) throw new WebAuthnError("key", "the RSA key is shorter than 2048 bits");
        if (exponent < 65537n || exponent % 2n === 0n) throw new WebAuthnError("key", "the RSA exponent is not accepted");
        algorithm = "RS256";
    } else {
        throw new WebAuthnError("key", "only ES256 (P-256) and RS256 (RSA) keys are accepted");
    }
    return { algorithm, key, spki: key.export({ type: "spki", format: "der" }) };
}

// ---- the page's data ---------------------------------------------------------------------------------------------------

interface ClientData {
    type: unknown;
    challenge: unknown;
    origin: unknown;
    crossOrigin?: unknown;
}

/** The challenge a clientDataJSON names, before anything is verified: used only to find which challenge it answers. */
export function challengeOf(clientDataJSON: Buffer): Buffer {
    return fromBase64Url(parseClientData(clientDataJSON).challenge, "the challenge");
}

function parseClientData(clientDataJSON: Buffer): ClientData {
    let parsed: unknown;
    try {
        parsed = JSON.parse(clientDataJSON.toString("utf8"));
    } catch {
        throw new WebAuthnError("malformed", "clientDataJSON is not JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new WebAuthnError("malformed", "clientDataJSON is not an object");
    return parsed as ClientData;
}

export interface CeremonyInput {
    clientDataJSON: Buffer;
    /** The 32 bytes the server issued for this ceremony. */
    expectedChallenge: Buffer;
    /** `http://localhost:<port>` and `http://127.0.0.1:<port>`, as served. */
    allowedOrigins: readonly string[];
}

function checkClientData(input: CeremonyInput, type: "webauthn.create" | "webauthn.get"): void {
    const data = parseClientData(input.clientDataJSON);
    if (data.type !== type) throw new WebAuthnError("type", `the ceremony is not ${type}`);
    const challenge = fromBase64Url(data.challenge, "the challenge");
    if (challenge.length !== input.expectedChallenge.length || !timingSafeEqual(challenge, input.expectedChallenge)) {
        throw new WebAuthnError("challenge", "the challenge is not the one issued");
    }
    if (typeof data.origin !== "string" || !input.allowedOrigins.includes(data.origin)) {
        throw new WebAuthnError("origin", "the page's origin is not this server's");
    }
    if (data.crossOrigin === true) throw new WebAuthnError("origin", "the page was framed from another origin");
}

function checkAuthenticatorData(auth: AuthenticatorData): void {
    if (!auth.rpIdHash.equals(sha256(Buffer.from(RP_ID)))) throw new WebAuthnError("rp-id", "the relying party id is not localhost");
    if (!auth.userPresent) throw new WebAuthnError("user-present", "the user was not present");
    if (!auth.userVerified) throw new WebAuthnError("user-verified", "the user was not verified (PIN, fingerprint or face)");
}

// ---- registration ------------------------------------------------------------------------------------------------------

export interface RegistrationInput extends CeremonyInput {
    attestationObject: Buffer;
}

export interface Registration {
    credentialId: Buffer;
    key: PublicKey;
    signCount: number;
}

/** Checks a new credential and returns its id and public key. The attestation statement is not examined. */
export function verifyRegistration(input: RegistrationInput): Registration {
    checkClientData(input, "webauthn.create");
    let attestation: Cbor;
    try {
        const decoded = decodeCbor(input.attestationObject);
        if (decoded.end !== input.attestationObject.length) throw new WebAuthnError("malformed", "attestation has trailing bytes");
        attestation = decoded.value;
    } catch (error) {
        if (error instanceof CborError) throw new WebAuthnError("malformed", `attestation: ${error.message}`);
        throw error;
    }
    const authData = attestation instanceof Map ? attestation.get("authData") : undefined;
    if (!(authData instanceof Uint8Array)) throw new WebAuthnError("malformed", "the attestation has no authData");
    const auth = parseAuthenticatorData(Buffer.from(authData));
    checkAuthenticatorData(auth);
    if (auth.credential === undefined) throw new WebAuthnError("malformed", "the attestation carries no credential");
    return { credentialId: auth.credential.id, key: publicKeyFromCose(auth.credential.publicKey), signCount: auth.signCount };
}

// ---- assertion ---------------------------------------------------------------------------------------------------------

export interface AssertionInput extends CeremonyInput {
    authenticatorData: Buffer;
    signature: Buffer;
    /** The registered key that should have signed. */
    key: PublicKey;
    /** The count stored with it after its last use. */
    storedSignCount: number;
}

/** Checks an assertion made with a registered key. Returns the counter to store. */
export function verifyAssertion(input: AssertionInput): { signCount: number } {
    checkClientData(input, "webauthn.get");
    const auth = parseAuthenticatorData(input.authenticatorData);
    if (auth.credential !== undefined) throw new WebAuthnError("malformed", "an assertion carries no new credential");
    checkAuthenticatorData(auth);

    const signed = Buffer.concat([input.authenticatorData, sha256(input.clientDataJSON)]);
    let valid = false;
    try {
        // ECDSA signatures are DER here, as WebAuthn sends them; RSA is PKCS#1 v1.5, node's default for an RSA key.
        valid = verify("sha256", signed, input.key.key, input.signature);
    } catch {
        valid = false;
    }
    if (!valid) throw new WebAuthnError("signature", "the signature does not match the registered key");

    // An authenticator with no counter reports 0 every time. Otherwise the counter must have gone up, or the credential may
    // have been cloned (specification 7.2, step 21).
    if ((auth.signCount !== 0 || input.storedSignCount !== 0) && auth.signCount <= input.storedSignCount) {
        throw new WebAuthnError("sign-count", "the signature counter did not go up: the key may have been cloned");
    }
    return { signCount: auth.signCount };
}
