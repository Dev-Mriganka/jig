import { createHmac } from "node:crypto";
import { MaskError } from "./error.ts";
import { canonicalIp } from "./ip.ts";
import { label } from "./kinds.ts";
import type { Kind } from "./kinds.ts";

const MIN_KEY_BYTES = 16;

function asciiLower(text: string): string {
    return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** The same value in different spellings must give the same token, or the model cannot correlate it. */
function canonical(kind: Kind, value: string): string {
    switch (kind) {
        case "email": return asciiLower(value.trim());
        case "ip": return canonicalIp(value) ?? asciiLower(value);
        default: return value;
    }
}

/** Keyed, deterministic pseudonyms: `email#3fa9c1` is the first three bytes of HMAC-SHA256(key, label NUL value).
 *  Three bytes keep tokens short for the model to read; a collision only merges two values, it reveals none. */
export class Tokens {
    readonly #key: Buffer;

    constructor(key: Uint8Array) {
        if (!(key instanceof Uint8Array) || key.length < MIN_KEY_BYTES) {
            throw new MaskError(`masking key must be at least ${MIN_KEY_BYTES} bytes`);
        }
        this.#key = Buffer.from(key); // a copy: later changes by the caller must not change tokens
    }

    mint(kind: Kind, value: string): string {
        const name = label(kind);
        const mac = createHmac("sha256", this.#key).update(name).update("\0").update(canonical(kind, value));
        const digest = mac.digest();
        return `${name}#${digest.subarray(0, 3).toString("hex")}`;
    }
}
