// A fake HTTP server on this machine, for the sign-in service and the transport to talk to. It records every request it gets, and
// answers each with the reply the test chose. Nothing outside 127.0.0.1 is contacted.
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
    method: string;
    /** The request line's target: a path for a server, the full address for a proxy. */
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
}

export interface Reply {
    status?: number;
    headers?: Record<string, string | string[]>;
    body?: string;
    /** Never answers, so a test can cancel the call. */
    hang?: boolean;
}

export interface FakeServer {
    port: number;
    address: string;
    seen: Seen[];
    /** Answers the next requests with this, instead of an empty 200. */
    reply(next: (seen: Seen) => Reply): void;
    close(): Promise<void>;
}

export async function fakeServer(): Promise<FakeServer> {
    const seen: Seen[] = [];
    let answer: (seen: Seen) => Reply = () => ({});
    const open = new Set<import("node:net").Socket>();
    const server: Server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const entry: Seen = {
                method: request.method ?? "",
                url: request.url ?? "",
                headers: request.headers,
                body: Buffer.concat(chunks).toString("utf8"),
            };
            seen.push(entry);
            const reply = answer(entry);
            if (reply.hang === true) return;
            response.writeHead(reply.status ?? 200, reply.headers);
            response.end(reply.body ?? "");
        });
    });
    server.on("connection", (socket) => {
        open.add(socket);
        socket.on("close", () => open.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        port,
        address: `http://127.0.0.1:${port}`,
        seen,
        reply: (next) => {
            answer = next;
        },
        close: () =>
            new Promise((resolve) => {
                for (const socket of open) socket.destroy();
                // The port is refused a moment after close reports: a request made at once can still see a reset.
                server.close(() => setTimeout(resolve, 30));
            }),
    };
}
