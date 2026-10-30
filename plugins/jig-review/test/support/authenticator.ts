// A fake authenticator: makes the bytes a browser would send for `navigator.credentials.create` and `.get`, signed with
// keys made by node:crypto. Every field a check looks at can be set wrong, so each check can be shown to refuse.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { RP_ID, toBase64Url } from "../../src/passkey/webauthn.ts";

// ---- a CBOR encoder, enough for an attestation object ------------------------------------------------------------------

export type Encodable = number | string | Uint8Array | Encodable[] | Array<[Encodable, Encodable]> | { map: Array<[Encodable, Encodable]> };

function head(major: number, value: number): Buffer {
    if (value < 24) return Buffer.from([(major << 5) | value]);
    if (value < 256) return Buffer.from([(major << 5) | 24, value]);
    if (value < 65536) return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff]);
    const out = Buffer.alloc(5);
    out[0] = (major << 5) | 26;
    out.writeUInt32BE(value, 1);
    return out;
}

export function encodeCbor(value: Encodable): Buffer {
    if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
    if (typeof value === "string") {
        const bytes = Buffer.from(value, "utf8");
        return Buffer.concat([head(3, bytes.length), bytes]);
    }
    if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
    if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...(value as Encodable[]).map(encodeCbor)]);
    const pairs = value.map;
    return Buffer.concat([head(5, pairs.length), ...pairs.flatMap(([k, v]) => [encodeCbor(k), encodeCbor(v)])]);
}

const sha256 = (data: Uint8Array): Buffer => createHash("sha256").update(data).digest();

// ---- the authenticator -------------------------------------------------------------------------------------------------

export interface Ceremony {
    /** The challenge the server issued, as the server holds it (base64url in the page's options). */
    challenge: Buffer | string;
    /** The page's origin. Default `http://localhost:<port>`. */
    origin: string;
}

/** Ways to get one ceremony wrong. Everything unset is right. */
export interface Faults {
    type?: string;
    /** Put this in clientDataJSON instead of the challenge. */
    challenge?: Buffer | string;
    origin?: string;
    crossOrigin?: boolean;
    /** The relying party id whose hash goes in authenticatorData. */
    rpId?: string;
    userPresent?: boolean;
    userVerified?: boolean;
    /** The counter to report. Default: the authenticator's own, raised by one for each assertion. */
    signCount?: number;
    /** Flip a bit of the signature. */
    badSignature?: boolean;
    /** Sign with this key instead of the authenticator's. */
    signWith?: KeyObject;
    /** Extra bytes after authenticatorData. */
    trailing?: Buffer;
    /** Report a different credential id than the one the authenticator made. */
    credentialId?: Buffer;
}

export interface Created {
    id: string;
    response: { clientDataJSON: string; attestationObject: string };
}

export interface Asserted {
    id: string;
    response: { clientDataJSON: string; authenticatorData: string; signature: string };
}

export class FakeAuthenticator {
    public readonly algorithm: "ES256" | "RS256";
    public readonly credentialId: Buffer;
    public readonly publicKey: KeyObject;
    private readonly privateKey: KeyObject;
    /** The counter the next assertion reports; 0 to model an authenticator with no counter. */
    public signCount: number;
    private readonly counting: boolean;

    public constructor(algorithm: "ES256" | "RS256" = "ES256", options: { counting?: boolean; modulusLength?: number; credentialId?: Buffer } = {}) {
        this.algorithm = algorithm;
        const pair =
            algorithm === "ES256"
                ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
                : generateKeyPairSync("rsa", { modulusLength: options.modulusLength ?? 2048 });
        this.publicKey = pair.publicKey;
        this.privateKey = pair.privateKey;
        this.credentialId = options.credentialId ?? sha256(Buffer.from(Math.random().toString())).subarray(0, 16);
        this.counting = options.counting ?? true;
        this.signCount = 0;
    }

    /** The key as a COSE map: what an authenticator puts in its attested credential data. */
    public cose(key: KeyObject = this.publicKey, alg: "ES256" | "RS256" = this.algorithm): Encodable {
        const jwk = key.export({ format: "jwk" }) as { x?: string; y?: string; n?: string; e?: string };
        const bytes = (value: string | undefined): Buffer => Buffer.from(value ?? "", "base64url");
        return alg === "ES256"
            ? { map: [[1, 2], [3, -7], [-1, 1], [-2, bytes(jwk.x)], [-3, bytes(jwk.y)]] }
            : { map: [[1, 3], [3, -257], [-1, bytes(jwk.n)], [-2, bytes(jwk.e)]] };
    }

    /** What `navigator.credentials.create` hands the page, as the page posts it. */
    public create(ceremony: Ceremony, faults: Faults = {}, coseOverride?: Encodable): Created {
        const credentialId = faults.credentialId ?? this.credentialId;
        const clientData = clientDataJSON(faults.type ?? "webauthn.create", faults.challenge ?? ceremony.challenge, faults.origin ?? ceremony.origin, faults.crossOrigin);
        const authData = Buffer.concat([
            authenticatorHeader(faults, 0x40, faults.signCount ?? 0),
            Buffer.alloc(16),
            u16(credentialId.length),
            credentialId,
            encodeCbor(coseOverride ?? this.cose()),
            faults.trailing ?? Buffer.alloc(0),
        ]);
        const attestation = encodeCbor({ map: [["fmt", "none"], ["attStmt", { map: [] }], ["authData", authData]] });
        return { id: toBase64Url(credentialId), response: { clientDataJSON: toBase64Url(clientData), attestationObject: toBase64Url(attestation) } };
    }

    /** What `navigator.credentials.get` hands the page, as the page posts it. */
    public get(ceremony: Ceremony, faults: Faults = {}): Asserted {
        const credentialId = faults.credentialId ?? this.credentialId;
        const clientData = clientDataJSON(faults.type ?? "webauthn.get", faults.challenge ?? ceremony.challenge, faults.origin ?? ceremony.origin, faults.crossOrigin);
        if (this.counting && faults.signCount === undefined) this.signCount += 1;
        const authData = Buffer.concat([authenticatorHeader(faults, 0, faults.signCount ?? (this.counting ? this.signCount : 0)), faults.trailing ?? Buffer.alloc(0)]);
        // Sign what the specification says: authenticatorData followed by the hash of the client data.
        const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), faults.signWith ?? this.privateKey);
        if (faults.badSignature) signature[signature.length - 1]! ^= 0x01;
        return { id: toBase64Url(credentialId), response: { clientDataJSON: toBase64Url(clientData), authenticatorData: toBase64Url(authData), signature: toBase64Url(signature) } };
    }
}

function clientDataJSON(type: string, challenge: Buffer | string, origin: string, crossOrigin?: boolean): Buffer {
    return Buffer.from(
        JSON.stringify({ type, challenge: typeof challenge === "string" ? challenge : toBase64Url(challenge), origin, ...(crossOrigin === undefined ? {} : { crossOrigin }) }),
    );
}

const u16 = (value: number): Buffer => Buffer.from([value >> 8, value & 0xff]);

/** rpIdHash, flags and counter: the first 37 bytes of authenticatorData. */
function authenticatorHeader(faults: Faults, extraFlags: number, signCount: number): Buffer {
    const flags = (faults.userPresent === false ? 0 : 0x01) | (faults.userVerified === false ? 0 : 0x04) | extraFlags;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount);
    return Buffer.concat([sha256(Buffer.from(faults.rpId ?? RP_ID)), Buffer.from([flags]), counter]);
}
