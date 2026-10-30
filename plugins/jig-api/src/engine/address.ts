// Which addresses a request may go to, checked for every request the tool sends, whatever the configuration says.
//
// Everything is https. Plain http is for this machine only, and only when the configuration allows it (`allowPlainLocal`,
// meant for a service run beside Pi and for tests). Two kinds of address are never called at all: link-local addresses
// and the cloud providers' metadata services, which hand out credentials to whoever asks from inside a machine, and the
// other forms of "this machine" (127.0.0.2, ::1, 0.0.0.0), which have no use here and are a way round a check on the name.
//
// The check reads the address as written. A host name is not looked up, so a name that points at a blocked address is not
// caught here; the hosts an environment may reach come from the team's own files (see resolve.ts), which keeps it to names
// the team chose.

const NOT_HTTPS =
    'must be an https address (plain http is only for 127.0.0.1 and localhost, ' +
    'with "allowPlainLocal": true in the api section)';

/** The two names of this machine that `allowPlainLocal` opens. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/** Names that stand for a cloud provider's metadata service. */
const METADATA_NAMES: ReadonlySet<string> = new Set([
    "metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal",
]);

/** Metadata addresses outside the link-local range: Alibaba Cloud's, and Oracle Cloud's older one. */
const METADATA_V4: ReadonlySet<string> = new Set(["100.100.100.200", "192.0.0.192"]);

function ipv4Of(host: string): [number, number, number, number] | undefined {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (match === null) return undefined;
    const parts = match.slice(1, 5).map(Number);
    if (parts.some((part) => part > 255)) return undefined;
    return parts as [number, number, number, number];
}

/** The eight 16-bit groups of an IPv6 address written without brackets, or undefined when it is not one. */
function ipv6Of(host: string): number[] | undefined {
    if (!/^[0-9a-f:.]+$/i.test(host) || !host.includes(":")) return undefined;
    let text = host;
    // A trailing dotted quad (::ffff:1.2.3.4) stands for the last two groups.
    const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (tail !== null) {
        const quad = ipv4Of(tail[1] as string);
        if (quad === undefined) return undefined;
        const high = ((quad[0] << 8) | quad[1]).toString(16);
        const low = ((quad[2] << 8) | quad[3]).toString(16);
        text = `${text.slice(0, text.length - (tail[1] as string).length)}${high}:${low}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return undefined;
    const group = (part: string): number[] | undefined => {
        if (part === "") return [];
        const numbers = part.split(":").map((item) => (/^[0-9a-f]{1,4}$/i.test(item) ? parseInt(item, 16) : Number.NaN));
        return numbers.some(Number.isNaN) ? undefined : numbers;
    };
    const head = group(halves[0] ?? "");
    const rest = halves.length === 2 ? group(halves[1] ?? "") : [];
    if (head === undefined || rest === undefined) return undefined;
    if (halves.length === 1) return head.length === 8 ? head : undefined;
    const missing = 8 - head.length - rest.length;
    return missing < 1 ? undefined : [...head, ...Array<number>(missing).fill(0), ...rest];
}

/** Why an IPv4 address is blocked, or undefined. `local` is true for a form of this machine. */
function blockedV4(parts: readonly [number, number, number, number]): { reason: string; local: boolean } | undefined {
    const [a, b] = parts;
    if (a === 169 && b === 254) return { reason: "a link-local or cloud metadata address", local: false };
    if (METADATA_V4.has(parts.join("."))) return { reason: "a cloud metadata address", local: false };
    if (a === 127 || a === 0) return { reason: "this machine", local: true };
    return undefined;
}

function blockedV6(groups: readonly number[]): { reason: string; local: boolean } | undefined {
    const [g0 = 0, g1 = 0] = groups;
    if (groups.every((group) => group === 0)) return { reason: "this machine", local: true };
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return { reason: "this machine", local: true };
    // fe80::/10 is link-local; fd00:ec2::254 is AWS's metadata service over IPv6.
    if ((g0 & 0xffc0) === 0xfe80) return { reason: "a link-local address", local: false };
    if (g0 === 0xfd00 && g1 === 0x0ec2 && groups[7] === 0x0254 && groups.slice(2, 7).every((group) => group === 0)) {
        return { reason: "a cloud metadata address", local: false };
    }
    // An IPv4 address written inside an IPv6 one (::ffff:a.b.c.d, or 64:ff9b::a.b.c.d) is the IPv4 address.
    const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
    const translated = g0 === 0x64 && g1 === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
    if (mapped || translated) {
        const high = groups[6] ?? 0;
        const low = groups[7] ?? 0;
        return blockedV4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    }
    return undefined;
}

/** Why a host (as `URL.hostname` writes it) is one of the blocked kinds. `local` hosts need `allowPlainLocal`. */
function blockedHost(hostname: string): { reason: string; local: boolean } | undefined {
    const host = hostname.replace(/\.$/, "").toLowerCase();
    if (METADATA_NAMES.has(host)) return { reason: "a cloud metadata address", local: false };
    if (host === "localhost" || host.endsWith(".localhost")) return { reason: "this machine", local: true };
    const v4 = ipv4Of(host);
    if (v4 !== undefined) return blockedV4(v4);
    if (host.startsWith("[") && host.endsWith("]")) {
        const v6 = ipv6Of(host.slice(1, -1));
        if (v6 !== undefined) return blockedV6(v6);
    }
    return undefined;
}

/**
 * Why an address may not be called, or undefined when it may. The request function asks this again for every request, so a
 * plan that was built some other way cannot reach a blocked address.
 */
export function addressProblem(address: unknown, allowPlainLocal: boolean): string | undefined {
    if (typeof address !== "string") return NOT_HTTPS;
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return NOT_HTTPS;
    }
    if (url.hostname === "") return NOT_HTTPS;
    if (url.username !== "" || url.password !== "") return "must not contain a user name or password";
    if (url.protocol !== "https:" && url.protocol !== "http:") return NOT_HTTPS;

    const blocked = blockedHost(url.hostname);
    if (blocked !== undefined) {
        if (!blocked.local) return `is ${blocked.reason}, which is never called`;
        if (!LOCAL_HOSTS.has(url.hostname)) return "is a form of this machine other than 127.0.0.1 and localhost, which is never called";
        return allowPlainLocal ? undefined : 'is this machine, which needs "allowPlainLocal": true in the api section';
    }
    return url.protocol === "https:" ? undefined : NOT_HTTPS;
}
