// A fake CI server, in two forms that answer from the same responder:
//   - a server on 127.0.0.1 for a catalog entry that signs in directly, so real requests cross a real socket;
//   - a transport, registered on the fake jig-core, for an entry that names one.
// Both record what they were sent. A responder decides each answer, and it can answer with a timeout, a stall or a reset
// connection, as a server under load does.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Transport } from "../../../jig-core/src/contract.ts";

/** The address a catalog entry names. The fake server answers it through `routeTo`. */
export const PUBLIC_URL = "https://ci.example.test";

export interface Recorded {
    method: string;
    /** The path, without the query. */
    path: string;
    /** The query, as the server read it. */
    query: URLSearchParams;
    /** Header names in lower case. */
    headers: Record<string, string>;
    /** The body as text; "" when there was none. */
    body: string;
}

export interface Answer {
    status?: number;
    /** The reply, serialised as JSON. */
    json?: unknown;
    /** The reply as it is, for a reply that is not JSON. */
    text?: string;
    /** Headers to send with the reply, such as `location`. */
    headers?: Record<string, string>;
    /** Cookies to set, each as `name=value; Path=/`. */
    cookies?: string[];
    /** Wait this long before answering. */
    delayMs?: number;
    /** Never answer: the server is stuck. */
    hang?: boolean;
    /** Break the connection without an answer. */
    reset?: boolean;
}

/** Answers request `number`, counting from 1. */
export type Responder = (request: Recorded, number: number) => Answer | Promise<Answer>;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FakeServer {
    /** `http://127.0.0.1:<port>`. */
    url: string;
    requests: Recorded[];
    close(): Promise<void>;
}

export async function startServer(responder: Responder): Promise<FakeServer> {
    const requests: Recorded[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", async () => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            const recorded: Recorded = {
                method: req.method ?? "GET",
                path: url.pathname,
                query: url.searchParams,
                headers: Object.fromEntries(
                    Object.entries(req.headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
                ),
                body: Buffer.concat(chunks).toString("utf8"),
            };
            requests.push(recorded);
            try {
                const answer = await responder(recorded, requests.length);
                if (answer.reset) return void req.socket.destroy();
                if (answer.hang) return;
                if (answer.delayMs !== undefined) await sleep(answer.delayMs);
                const headers: Record<string, string | string[]> = {
                    "content-type": answer.text === undefined ? "application/json" : "text/plain",
                    ...answer.headers,
                };
                if (answer.cookies !== undefined) headers["set-cookie"] = answer.cookies;
                res.writeHead(answer.status ?? 200, headers);
                res.end(answer.text ?? JSON.stringify(answer.json ?? {}));
            } catch (error) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ message: `fake server error: ${String(error)}` }));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/** A `fetch` that sends the configured address to the fake server instead, and counts nothing else. */
export function routeTo(server: FakeServer, publicUrl = PUBLIC_URL): typeof fetch {
    return (input, init) => fetch(String(input).replace(publicUrl, server.url), init);
}

export interface FakeTransport extends Transport {
    requests: Recorded[];
}

/** A transport that answers like the server. It records what it was sent, and the URL as the tool wrote it. */
export function fakeTransport(responder: Responder): FakeTransport {
    const requests: Recorded[] = [];
    return {
        requests,
        async request(request, signal) {
            const url = new URL(request.url);
            const recorded: Recorded = {
                method: request.method,
                path: url.pathname,
                query: url.searchParams,
                headers: Object.fromEntries(
                    Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
                ),
                body: request.body ?? "",
            };
            requests.push(recorded);
            const answer = await responder(recorded, requests.length);
            if (answer.reset) throw new Error("the connection was reset");
            if (answer.hang) {
                return new Promise((_, reject) => {
                    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
            }
            if (answer.delayMs !== undefined) await sleep(answer.delayMs);
            return {
                status: answer.status ?? 200,
                headers: {
                    "content-type": answer.text === undefined ? "application/json" : "text/plain",
                    ...answer.headers,
                    ...(answer.cookies === undefined ? {} : { "set-cookie": answer.cookies.join(", ") }),
                },
                body: answer.text ?? JSON.stringify(answer.json ?? {}),
            };
        },
    };
}
