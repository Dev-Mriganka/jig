// Host patterns, as `network.allow`, `network.deny` and the kept answers write them: a name (`api.example.com`) or all the
// subdomains of one (`*.example.com`), with an optional port (`api.example.com:443`). A pattern with no port covers every port.
// `*.example.com` covers the subdomains and not `example.com` itself, as the sandbox runtime reads it.
import { cleanHost } from "./addresses.ts";

export interface HostPattern {
    /** The name, or the name after `*.` for a wildcard. */
    host: string;
    wildcard: boolean;
    port: number | undefined;
}

/** A pattern as text, or undefined when it is not one. An IPv6 address is written in brackets: `[2606:4700::1111]:443`. */
export function parsePattern(text: string): HostPattern | undefined {
    const trimmed = text.trim();
    const v6 = /^\[([0-9A-Fa-f:.]+)\](?::([0-9]{1,5}))?$/.exec(trimmed);
    const match = v6 ?? /^(\*\.)?([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]|[A-Za-z0-9])(?::([0-9]{1,5}))?$/.exec(trimmed);
    if (match === null) return undefined;
    const portText = v6 === null ? match[3] : match[2];
    const port = portText === undefined ? undefined : Number(portText);
    if (port !== undefined && (port < 1 || port > 65535)) return undefined;
    if (v6 !== null) return { host: cleanHost(v6[1] as string), wildcard: false, port };
    return { host: cleanHost(match[2] as string), wildcard: match[1] !== undefined, port };
}

/** The pattern a host and port are kept as: `api.example.com:443`, or `[2606:4700::1111]:443`. */
export function entryFor(host: string, port: number): string {
    return hostPort(host, port);
}

/** Whether the pattern covers this host and port. `host` is already cleaned. */
export function matchesHost(pattern: HostPattern, host: string, port: number): boolean {
    if (pattern.port !== undefined && pattern.port !== port) return false;
    return pattern.wildcard ? host.endsWith(`.${pattern.host}`) : host === pattern.host;
}

/** The first of these patterns (as text) that covers the host and port, or undefined. */
export function firstMatch(patterns: readonly string[], host: string, port: number): string | undefined {
    for (const text of patterns) {
        const pattern = parsePattern(text);
        if (pattern !== undefined && matchesHost(pattern, host, port)) return text;
    }
    return undefined;
}

/** `host:port` for a message, with an IPv6 address in brackets. */
export function hostPort(host: string, port: number): string {
    return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}
