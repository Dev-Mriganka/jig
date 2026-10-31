// Which hosts the company's sign-in service and transport will serve. A sign-in service is handed the full address of each
// request, and a transport carries it, so each can refuse a request for a host that is not the company's: a credential that
// the company's service adds must never go to an address somebody else chose.
//
// An entry that starts with a dot matches every name below it (`.acme.example` matches `logs.acme.example`, not `acme.example`
// itself); any other entry matches that host exactly. A credential also never travels in clear text across a network: the
// address must be https, unless the host is this machine.

/** The hosts Acme's services answer for. */
export const ACME_HOSTS: readonly string[] = [".acme.example", "acme.atlassian.net"];

const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopback(host: string): boolean {
    return LOOPBACK.has(host.toLowerCase());
}

/** True when `address` is a URL for one of `hosts`, over https (or to this machine). A string that is no URL is refused. */
export function hostAllowed(address: string, hosts: readonly string[]): boolean {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return false;
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(host))) return false;
    return hosts.some((entry) => (entry.startsWith(".") ? host.endsWith(entry) : host === entry));
}
