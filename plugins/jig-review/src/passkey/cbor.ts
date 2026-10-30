// A small CBOR decoder: only what a WebAuthn attestation object and a COSE key use. Unsigned and negative integers,
// byte and text strings, arrays, maps (keys are integers or text, each at most once), and the simple values false, true,
// null and undefined. Everything else is refused: floats, tags, indefinite lengths and other key types do not occur in
// the data an authenticator sends, so a message that has them is not one to trust.

export type Cbor = number | string | Uint8Array | boolean | null | undefined | Cbor[] | Map<number | string, Cbor>;

export class CborError extends Error {}

const MAX_DEPTH = 8;

/** The first value in `bytes` from `offset`, and where it ends. */
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: Cbor; end: number } {
    const reader = { bytes, at: offset };
    const value = readItem(reader, 0);
    return { value, end: reader.at };
}

/** The value that is all of `bytes`: trailing bytes are an error. */
export function decodeCborExactly(bytes: Uint8Array): Cbor {
    const { value, end } = decodeCbor(bytes);
    if (end !== bytes.length) throw new CborError("trailing bytes after the CBOR value");
    return value;
}

interface Reader {
    bytes: Uint8Array;
    at: number;
}

function take(reader: Reader, length: number): Uint8Array {
    if (length < 0 || reader.at + length > reader.bytes.length) throw new CborError("CBOR value runs past the end of the data");
    const slice = reader.bytes.subarray(reader.at, reader.at + length);
    reader.at += length;
    return slice;
}

/** The argument of an item: the low five bits of its first byte, or the 1, 2, 4 or 8 bytes after it. */
function readArgument(reader: Reader, info: number): number {
    if (info < 24) return info;
    if (info > 27) throw new CborError(info === 31 ? "indefinite-length CBOR is not allowed" : "invalid CBOR argument");
    const size = 1 << (info - 24);
    const raw = take(reader, size);
    let value = 0n;
    for (const byte of raw) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("CBOR integer too large");
    return Number(value);
}

function readItem(reader: Reader, depth: number): Cbor {
    if (depth > MAX_DEPTH) throw new CborError("CBOR nested too deeply");
    const first = take(reader, 1)[0]!;
    const major = first >> 5;
    const info = first & 0x1f;
    switch (major) {
        case 0:
            return readArgument(reader, info);
        case 1:
            return -1 - readArgument(reader, info);
        case 2:
            return Uint8Array.from(take(reader, readArgument(reader, info)));
        case 3:
            try {
                return new TextDecoder("utf-8", { fatal: true }).decode(take(reader, readArgument(reader, info)));
            } catch (error) {
                if (error instanceof CborError) throw error;
                throw new CborError("CBOR text is not valid UTF-8");
            }
        case 4: {
            const count = readArgument(reader, info);
            // Every item takes at least a byte, so a count beyond what is left is a lie that would waste memory.
            if (count > reader.bytes.length - reader.at) throw new CborError("CBOR array longer than its data");
            const items: Cbor[] = [];
            for (let i = 0; i < count; i++) items.push(readItem(reader, depth + 1));
            return items;
        }
        case 5: {
            const count = readArgument(reader, info);
            if (count > reader.bytes.length - reader.at) throw new CborError("CBOR map longer than its data");
            const map = new Map<number | string, Cbor>();
            for (let i = 0; i < count; i++) {
                const key = readItem(reader, depth + 1);
                if (typeof key !== "number" && typeof key !== "string") throw new CborError("CBOR map key is not an integer or text");
                if (map.has(key)) throw new CborError("CBOR map repeats a key");
                map.set(key, readItem(reader, depth + 1));
            }
            return map;
        }
        case 7:
            if (info === 20) return false;
            if (info === 21) return true;
            if (info === 22) return null;
            if (info === 23) return undefined;
            throw new CborError("CBOR floats and other simple values are not allowed");
        default:
            throw new CborError("CBOR tags are not allowed");
    }
}
