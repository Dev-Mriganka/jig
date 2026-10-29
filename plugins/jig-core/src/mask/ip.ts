// IPv4/IPv6 parsing and canonical text, so `2001:DB8::A`, `2001:db8:0:0:0:0:0:a` and `::ffff:c000:201`
// mask to the same token whichever field or sentence they appear in.

/** Four octets, or undefined. Leading zeros are accepted (devices print `010.000.000.001`) and read as decimal. */
export function parseIPv4(text: string): number[] | undefined {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
    if (match === null) return undefined;
    const octets = match.slice(1).map(Number);
    return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/** Eight 16-bit groups, or undefined. Accepts `::` compression and an embedded IPv4 tail. */
export function parseIPv6(text: string): number[] | undefined {
    if (!text.includes(":")) return undefined;
    let head = text;
    let tail: number[] = [];
    if (text.includes(".")) {
        const cut = text.lastIndexOf(":");
        const v4 = parseIPv4(text.slice(cut + 1));
        if (v4 === undefined) return undefined;
        tail = [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)];
        head = text.slice(0, cut + 1);
        if (!head.endsWith("::")) {
            if (!head.endsWith(":")) return undefined;
            head = head.slice(0, -1);
        }
    }
    const halves = head.split("::");
    if (halves.length > 2) return undefined;
    const groups = (part: string): number[] =>
        part === "" ? [] : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN));
    const left = groups(halves[0] ?? "");
    const right = [...groups(halves[1] ?? ""), ...tail];
    if ([...left, ...right].some(Number.isNaN)) return undefined;
    const missing = 8 - left.length - right.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
    return [...left, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...right];
}

function formatIPv6(groups: number[]): string {
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        const [g6 = 0, g7 = 0] = groups.slice(6);
        return `::ffff:${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
    }
    let bestStart = -1;
    let bestLength = 1; // a single zero group is never compressed (RFC 5952)
    for (let start = 0; start < 8; ) {
        if (groups[start] !== 0) { start++; continue; }
        let end = start;
        while (end < 8 && groups[end] === 0) end++;
        if (end - start > bestLength) { bestStart = start; bestLength = end - start; }
        start = end;
    }
    const hex = (slice: number[]): string => slice.map((g) => g.toString(16)).join(":");
    if (bestStart < 0) return hex(groups);
    return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
}

/** Canonical text of an IP address, or undefined when `text` is not one. */
export function canonicalIp(text: string): string | undefined {
    const v4 = parseIPv4(text);
    if (v4 !== undefined) return v4.join(".");
    const v6 = parseIPv6(text);
    return v6 === undefined ? undefined : formatIPv6(v6);
}

/** Internal addresses stay readable: they identify infrastructure, not a customer. */
function isInternalIPv4(octets: number[]): boolean {
    const [a = 0, b = 0] = octets;
    return (
        a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
    );
}

function isInternalIPv6(groups: number[]): boolean {
    const [first = 0] = groups;
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        const [g6 = 0, g7 = 0] = groups.slice(6);
        return isInternalIPv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
    }
    const loopbackOrUnspecified = groups.slice(0, 7).every((g) => g === 0) && (groups[7] === 0 || groups[7] === 1);
    return loopbackOrUnspecified || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** True for a valid private, loopback, link-local or unspecified address; false for a public one or a non-address. */
export function isInternalIp(text: string): boolean {
    const v4 = parseIPv4(text);
    if (v4 !== undefined) return isInternalIPv4(v4);
    const v6 = parseIPv6(text);
    return v6 !== undefined && isInternalIPv6(v6);
}
