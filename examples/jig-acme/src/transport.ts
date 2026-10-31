// A transport: code that carries a whole request, for systems that Jig's own network cannot reach or that only a company's
// proxy may talk to. A real company puts here its way in: a local sign-in proxy that holds the session, a VPN gateway's API, a
// browser-session broker. A request names the transport (`transport: "acme-gateway"`, or `"transport"` in a plugin's section),
// and the tool then holds no credential at all: the proxy signs in.
//
// This one sends the request to a corporate gateway on this machine as an HTTP proxy would be asked: the request line carries the
// full address, and the gateway makes the call to the real host over TLS. Only the gateway's own address is plain http, and
// config.ts accepts nothing but a local one, so nothing is sent in clear text across a network. To reach a gateway that is not on
// this machine, speak CONNECT and TLS to it instead (node:http's `connect` event, then node:tls).
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { hostAllowed } from "./hosts.ts";
import type { JigApi, Transport, TransportRequest, TransportResponse } from "./jig/types.ts";

export const GATEWAY_TRANSPORT = "acme-gateway";

/** The most reply text that is read: the same as the default cap of `http.request`. A transport is not told the caller's own. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface GatewayOptions {
    /** The address of the gateway, such as http://127.0.0.1:3128. Asked for every request. */
    proxy(): URL;
    /** The hosts this transport carries requests to. */
    hosts: readonly string[];
}

/** The reply's headers as text, in lower case (Node already lower-cases the names); a repeated header is folded. */
function headersOf(raw: IncomingHttpHeaders): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
}

/** The request's headers without the two the gateway request sets itself. */
function forwarded(request: TransportRequest, body: Buffer | undefined, target: URL): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (!/^(host|content-length|connection|proxy-.*)$/i.test(name)) headers[name] = value;
    }
    headers.Host = target.host;
    headers.Connection = "close";
    if (body !== undefined) headers["Content-Length"] = String(body.byteLength);
    return headers;
}

export function createGatewayTransport(options: GatewayOptions): Transport {
    return {
        request(request, signal): Promise<TransportResponse> {
            return new Promise((resolve, reject) => {
                // The messages name no address: it could hold a query.
                if (!hostAllowed(request.url, options.hosts)) {
                    reject(new Error(`${GATEWAY_TRANSPORT} carries requests to Acme hosts only`));
                    return;
                }
                const target = new URL(request.url);
                const proxy = options.proxy();
                const body = request.body === undefined ? undefined : Buffer.from(request.body, "utf8");
                const call = httpRequest(
                    {
                        // A URL keeps the brackets of an IPv6 host; the socket wants it without.
                        host: proxy.hostname.replace(/^\[|\]$/g, ""),
                        port: proxy.port === "" ? 80 : Number(proxy.port),
                        method: request.method,
                        path: request.url,
                        headers: forwarded(request, body, target),
                        ...(signal === undefined ? {} : { signal }),
                    },
                    (reply) => {
                        const chunks: Buffer[] = [];
                        let size = 0;
                        reply.on("data", (chunk: Buffer) => {
                            if (size >= MAX_BODY_BYTES) return;
                            chunks.push(
                                size + chunk.length > MAX_BODY_BYTES ? chunk.subarray(0, MAX_BODY_BYTES - size) : chunk,
                            );
                            size += chunk.length;
                        });
                        reply.on("error", reject);
                        reply.on("end", () =>
                            resolve({
                                status: reply.statusCode ?? 502,
                                headers: headersOf(reply.headers),
                                body: Buffer.concat(chunks).toString("utf8"),
                            }),
                        );
                    },
                );
                // A refused or reset connection: say that the gateway failed, with its error code and nothing from the request.
                call.on("error", (error: NodeJS.ErrnoException) =>
                    reject(
                        signal?.aborted === true
                            ? error
                            : new Error(
                                  `the gateway could not be reached${error.code === undefined ? "" : ` (${error.code})`}`,
                              ),
                    ),
                );
                call.end(body);
            });
        },
    };
}

export function registerTransport(api: JigApi, proxy: () => URL, hosts: readonly string[]): void {
    api.transports.register(GATEWAY_TRANSPORT, createGatewayTransport({ proxy, hosts }));
}
