// A fake API on this machine: a real HTTP server (node:http) on 127.0.0.1 that records every request it receives and answers
// from a function the test sets. A reply can also misbehave: come late, never come, or cut the connection. That is how "the
// reply to a write was lost" is made.
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request as the server received it. */
export interface Recorded {
    method: string;
    /** The request target as it arrived on the wire: the path and the query. */
    target: string;
    path: string;
    query: string;
    /** Lower-case names. */
    headers: Record<string, string>;
    body: string;
}

export interface Reply {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
    /** Wait this long before answering. */
    delayMs?: number;
    /** Never answer. */
    hang?: boolean;
    /** Close the connection without answering. */
    drop?: boolean;
    /** Send the status line and part of the body, then close the connection. */
    halfway?: boolean;
}

export interface FakeApi {
    /** `http://127.0.0.1:<port>`. */
    origin: string;
    port: number;
    requests: Recorded[];
    /** How requests are answered. The default is 200 with `{"ok":true}`. `index` counts the requests received. */
    respond: (request: Recorded, index: number) => Reply | Promise<Reply>;
    /** Back to the default answer, with no request recorded. */
    reset(): void;
    close(): Promise<void>;
}

const OK: Reply = { body: '{"ok":true}' };

function send(request: IncomingMessage, response: ServerResponse, reply: Reply): void {
    const act = (): void => {
        if (reply.drop === true) {
            request.socket.destroy();
        } else if (reply.hang === true) {
            // The connection stays open; closing the server ends it.
        } else if (reply.halfway === true) {
            response.writeHead(reply.status ?? 200, { "content-length": "1000", ...reply.headers });
            response.write("partial");
            setTimeout(() => request.socket.destroy(), 20).unref();
        } else {
            response.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
            response.end(reply.body ?? OK.body);
        }
    };
    if (reply.delayMs === undefined) act();
    else setTimeout(act, reply.delayMs).unref();
}

export function startFakeApi(): Promise<FakeApi> {
    const fake: FakeApi = {
        origin: "",
        port: 0,
        requests: [],
        respond: () => OK,
        reset() {
            fake.requests = [];
            fake.respond = () => OK;
        },
        close: () =>
            new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };

    const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const target = request.url ?? "";
            const mark = target.indexOf("?");
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(request.headers)) {
                if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
            }
            const recorded: Recorded = {
                method: request.method ?? "",
                target,
                path: mark < 0 ? target : target.slice(0, mark),
                query: mark < 0 ? "" : target.slice(mark + 1),
                headers,
                body: Buffer.concat(chunks).toString("utf8"),
            };
            fake.requests.push(recorded);
            void Promise.resolve(fake.respond(recorded, fake.requests.length - 1)).then((reply) =>
                send(request, response, reply),
            );
        });
    });

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            fake.port = (server.address() as AddressInfo).port;
            fake.origin = `http://127.0.0.1:${fake.port}`;
            resolve(fake);
        });
    });
}

/** A local port that nothing listens on, for a connection that is refused. */
export async function closedPort(): Promise<number> {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}
