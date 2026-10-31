// What an address or a host name is, for deciding whether a connection may leave the sandbox. The proxy dials an approved IP
// address with no further check (a spike showed it), so the callback must refuse the addresses that reach this machine, its
// neighbours and the cloud's metadata service itself. This file only classifies; `policy.ts` decides.
import net from "node:net";
import os from "node:os";

/** What kind of address it is. `undefined` from `rangeOf` means a public address. */
export type Range =
    | "metadata"
    | "loopback"
    | "own"
    | "link-local"
    | "private"
    | "carrier"
    | "unspecified"
    | "multicast"
    | "reserved";

/** Cloud metadata services: addresses and names. They are refused in every mode and whatever is configured. */
const METADATA_NAMES: ReadonlySet<string> = new Set([
    "metadata.google.internal",
    "metadata.goog",
    "metadata",
    "instance-data",
    "instance-data.ec2.internal",
    "metadata.azure.com",
    "metadata.tencentyun.com",
    "100.100.100.200",
]);

const METADATA_ADDRESSES: ReadonlySet<string> = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200"]);

/** Four bytes of an IPv4 address, or undefined when it is not one in the usual dotted form. */
export function parseIPv4(text: string): number[] | undefined {
    if (!net.isIPv4(text)) return undefined;
    return text.split(".").map(Number);
}

/** Sixteen bytes of an IPv6 address (an embedded IPv4 tail included), or undefined. A zone (`%eth0`) is not accepted. */
export function parseIPv6(text: string): number[] | undefined {
    if (!net.isIPv6(text) || text.includes("%")) return undefined;
    let head = text;
    let tail4: number[] = [];
    const lastColon = head.lastIndexOf(":");
    const last = head.slice(lastColon + 1);
    if (last.includes(".")) {
        const v4 = parseIPv4(last);
        if (v4 === undefined) return undefined;
        tail4 = v4;
        head = `${head.slice(0, lastColon + 1)}0:0`;
    }
    const [left = "", right] = head.split("::");
    const groups = (part: string): number[] =>
        part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16));
    const front = groups(left);
    const back = right === undefined ? [] : groups(right);
    const missing = 8 - front.length - back.length;
    if (right === undefined ? front.length !== 8 : missing < 0) return undefined;
    const words = right === undefined ? front : [...front, ...Array<number>(missing).fill(0), ...back];
    const bytes = words.flatMap((word) => [(word >> 8) & 0xff, word & 0xff]);
    if (tail4.length === 4) bytes.splice(12, 4, ...tail4);
    return bytes;
}

/** The text of an IPv4 address from its bytes. */
const dotted = (bytes: readonly number[]): string => bytes.join(".");

function inV4(bytes: readonly number[], first: readonly number[], bits: number): boolean {
    let remaining = bits;
    for (let index = 0; index < 4 && remaining > 0; index++) {
        const take = Math.min(8, remaining);
        const mask = (0xff << (8 - take)) & 0xff;
        if (((bytes[index] ?? 0) & mask) !== ((first[index] ?? 0) & mask)) return false;
        remaining -= take;
    }
    return true;
}

function rangeOfV4(bytes: readonly number[]): Range | undefined {
    const text = dotted(bytes);
    if (METADATA_ADDRESSES.has(text)) return "metadata";
    if (inV4(bytes, [127, 0, 0, 0], 8)) return "loopback";
    if (inV4(bytes, [0, 0, 0, 0], 8)) return "unspecified";
    if (inV4(bytes, [169, 254, 0, 0], 16)) return "link-local";
    if (inV4(bytes, [10, 0, 0, 0], 8) || inV4(bytes, [172, 16, 0, 0], 12) || inV4(bytes, [192, 168, 0, 0], 16)) {
        return "private";
    }
    if (inV4(bytes, [100, 64, 0, 0], 10)) return "carrier";
    if (inV4(bytes, [224, 0, 0, 0], 4)) return "multicast";
    // Not routable on the public network: this network, documentation, benchmarking, the future and the broadcast address.
    if (
        inV4(bytes, [192, 0, 0, 0], 24) ||
        inV4(bytes, [192, 0, 2, 0], 24) ||
        inV4(bytes, [198, 18, 0, 0], 15) ||
        inV4(bytes, [198, 51, 100, 0], 24) ||
        inV4(bytes, [203, 0, 113, 0], 24) ||
        inV4(bytes, [240, 0, 0, 0], 4)
    ) {
        return "reserved";
    }
    return undefined;
}

function rangeOfV6(bytes: readonly number[]): Range | undefined {
    const text = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (text === "fd000ec2000000000000000000000254") return "metadata";
    if (text === "00000000000000000000000000000001") return "loopback";
    if (/^0{32}$/.test(text)) return "unspecified";
    // Addresses that carry an IPv4 address are judged by it: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64
    // (64:ff9b::a.b.c.d), 6to4 (2002:aabb:ccdd::) and the IPv4 address in a Teredo address.
    if (/^0{20}ffff/.test(text) || /^0{24}/.test(text)) return rangeOfV4(bytes.slice(12, 16));
    if (text.startsWith("0064ff9b0000000000000000")) return rangeOfV4(bytes.slice(12, 16));
    if (text.startsWith("2002")) return rangeOfV4(bytes.slice(2, 6));
    if (text.startsWith("20010000")) return "reserved";
    const first = bytes[0] ?? 0;
    const second = bytes[1] ?? 0;
    if (first === 0xfe && (second & 0xc0) === 0x80) return "link-local";
    if ((first & 0xfe) === 0xfc) return "private";
    if (first === 0xff) return "multicast";
    if (first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return "reserved";
    return undefined;
}

/** The range of an IP literal (brackets and a trailing dot are not part of it), or undefined for a public address or a name. */
export function rangeOf(address: string): Range | undefined {
    const v4 = parseIPv4(address);
    if (v4 !== undefined) return rangeOfV4(v4);
    const v6 = parseIPv6(address);
    return v6 === undefined ? undefined : rangeOfV6(v6);
}

/** The addresses of this machine's own network interfaces, as text. */
export function ownAddresses(): string[] {
    const found: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const item of list ?? []) found.push(item.address.split("%")[0] as string);
    }
    return found;
}

/** The same address written the same way, so `::ffff:127.0.0.1` and `127.0.0.1` are compared as what they are. */
export function canonicalAddress(address: string): string | undefined {
    const v4 = parseIPv4(address);
    if (v4 !== undefined) return dotted(v4);
    const v6 = parseIPv6(address);
    if (v6 === undefined) return undefined;
    if (/^(?:0{20}ffff)/i.test(v6.map((byte) => byte.toString(16).padStart(2, "0")).join("")))
        return dotted(v6.slice(12, 16));
    return v6.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A host as the proxy gives it to the callback, cleaned: lower case, no brackets, no trailing dot. */
export function cleanHost(host: string): string {
    let text = host.trim().toLowerCase();
    if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
    while (text.endsWith(".")) text = text.slice(0, -1);
    return text;
}

/**
 * What a host is: an IP address (with its range), or a name. A name must look like one: labels of letters, digits and
 * dashes, and a last label of letters only (or `xn--`), so `0x7f000001`, `127.1` and `2130706433`, which some programs read
 * as `127.0.0.1`, are not names and are refused.
 */
export type HostKind =
    | { kind: "ip"; address: string; range: Range | undefined }
    | { kind: "name"; name: string; metadata: boolean; localhost: boolean }
    | { kind: "invalid" };

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TOP_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function classifyHost(host: string, own: ReadonlySet<string> = new Set()): HostKind {
    const text = cleanHost(host);
    if (text === "" || text.length > 253) return { kind: "invalid" };
    if (net.isIP(text) !== 0) {
        // An address with a zone (`fe80::1%eth0`) or one this file cannot read is not judged by guessing: it is refused.
        const canonical = canonicalAddress(text);
        if (canonical === undefined) return { kind: "invalid" };
        let range = rangeOf(text);
        // An address of this machine's own interfaces (also a private one, such as the LAN address) reaches this machine.
        if (range !== "metadata" && range !== "loopback" && own.has(canonical)) range = "own";
        return { kind: "ip", address: canonical, range };
    }
    if (text.includes(":") || text.includes("%")) return { kind: "invalid" };
    const labels = text.split(".");
    if (!labels.every((label) => LABEL.test(label))) {
        // A single word such as `metadata` or `localhost` is a name too: it has no top-level label to check.
        return { kind: "invalid" };
    }
    const last = labels.at(-1) as string;
    const single = labels.length === 1;
    if (!single && !TOP_LABEL.test(last)) return { kind: "invalid" };
    if (single && !/^[a-z][a-z0-9-]*$/.test(last)) return { kind: "invalid" };
    return {
        kind: "name",
        name: text,
        metadata: METADATA_NAMES.has(text),
        localhost: text === "localhost" || text.endsWith(".localhost"),
    };
}
