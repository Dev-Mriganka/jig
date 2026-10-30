// Text that is not all known yet. A request's headers and body, and its sign-in, are made of pieces: plain text, secrets
// that are read from jig-core when the request is sent, values that are generated when it is sent (a new id, the time),
// and the bytes of a file to upload.
//
// Keeping those apart from the plain text is what lets the plan be made without touching a secret: the preview, the
// fingerprint and every message show the pieces by name, and only `fill` turns them into the text that goes out.
import { createHash, randomUUID } from "node:crypto";

/** A secret variable and the reference that supplies it. The value is read only when the request is sent. */
export interface Secret {
    secret: string;
    reference: string;
    /** How the value is written where it sits: inside a JSON string, or in a URL-encoded form. */
    as?: "json" | "form";
}

/** A value made when the request is sent, so that a preview and the request itself do not differ by an id or a clock. */
export interface Generated {
    generated: "uuid" | "timestamp" | "isoTimestamp";
}

/** A file to upload, read when the plan was made. The digest is what the fingerprint holds. */
export interface Upload {
    upload: string;
    bytes: Uint8Array;
    sha256: string;
}

export type Piece = string | Secret | Generated | Upload;
export type Text = readonly Piece[];

export const isSecret = (piece: Piece): piece is Secret => typeof piece === "object" && "secret" in piece;
export const isGenerated = (piece: Piece): piece is Generated => typeof piece === "object" && "generated" in piece;
export const isUpload = (piece: Piece): piece is Upload => typeof piece === "object" && "upload" in piece;

export function upload(name: string, bytes: Uint8Array): Upload {
    return { upload: name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The pieces one after the other, with neighbouring plain text joined. */
export function joined(...parts: ReadonlyArray<Text | Piece>): Text {
    const out: Piece[] = [];
    for (const part of parts) {
        for (const piece of typeof part === "object" && Array.isArray(part) ? (part as Text) : [part as Piece]) {
            const last = out.at(-1);
            if (typeof piece === "string") {
                if (piece === "") continue;
                if (typeof last === "string") out[out.length - 1] = last + piece;
                else out.push(piece);
            } else {
                out.push(piece);
            }
        }
    }
    return out;
}

/** The text when it holds nothing but plain text, else undefined. */
export function plainOf(text: Text): string | undefined {
    return text.every((piece) => typeof piece === "string") ? text.join("") : undefined;
}

/** How a piece reads in a preview, a message or a fingerprint: secrets and generated values by name, never their value. */
export function displayOf(text: Text): string {
    return text
        .map((piece) => {
            if (typeof piece === "string") return piece;
            if (isSecret(piece)) return `{{${piece.secret}}}`;
            if (isGenerated(piece)) return `{{$${piece.generated}}}`;
            return `<file ${piece.upload}, ${piece.bytes.byteLength} bytes, sha256 ${piece.sha256.slice(0, 12)}>`;
        })
        .join("");
}

/** How many bytes the text is, as far as it is known: a secret and a generated value are not counted. */
export function byteLengthOf(text: Text): number {
    return text.reduce<number>((total, piece) => {
        if (typeof piece === "string") return total + Buffer.byteLength(piece);
        return total + (isUpload(piece) ? piece.bytes.byteLength : 0);
    }, 0);
}

/** The secrets in a text, once each, by name. */
export function secretsIn(text: Text): Secret[] {
    const seen = new Map<string, Secret>();
    for (const piece of text) if (typeof piece === "object" && isSecret(piece)) seen.set(piece.secret, piece);
    return [...seen.values()];
}

/** The generated values in a text, once each. */
export function generatedIn(text: Text): string[] {
    return [...new Set(text.filter(isGenerated).map((piece) => `$${piece.generated}`))];
}

/** What `fill` needs from the outside. */
export interface Fillers {
    /** Reads a secret. May throw; the caller words the failure. */
    secret(reference: string): Promise<string>;
    now(): number;
    /** Every secret value read is added here, so that the answer can be cleaned of it. */
    credentials: string[];
}

function generatedValue(piece: Generated, now: () => number): string {
    switch (piece.generated) {
        case "uuid":
            return randomUUID();
        case "timestamp":
            return String(Math.floor(now() / 1000));
        case "isoTimestamp":
            return new Date(now()).toISOString();
    }
}

function written(secret: Secret, value: string): string {
    if (secret.as === "json") return JSON.stringify(value).slice(1, -1);
    if (secret.as === "form") return encodeURIComponent(value);
    return value;
}

/** The text a request is sent with: text when there is no file in it, else bytes. */
export async function fill(text: Text, fillers: Fillers): Promise<string | Uint8Array> {
    const chunks: Array<string | Uint8Array> = [];
    for (const piece of text) {
        if (typeof piece === "string") {
            chunks.push(piece);
        } else if (isSecret(piece)) {
            const value = await fillers.secret(piece.reference);
            fillers.credentials.push(value);
            chunks.push(written(piece, value));
        } else if (isGenerated(piece)) {
            chunks.push(generatedValue(piece, fillers.now));
        } else {
            chunks.push(piece.bytes);
        }
    }
    if (chunks.every((chunk) => typeof chunk === "string")) return chunks.join("");
    return Buffer.concat(chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk)));
}

/** The same, for text that cannot hold a file (a header, a credential). */
export async function fillString(text: Text, fillers: Fillers): Promise<string> {
    const filled = await fill(text, fillers);
    return typeof filled === "string" ? filled : Buffer.from(filled).toString("utf8");
}
