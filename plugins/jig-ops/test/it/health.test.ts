// The `runtime` tool's health check by address, against a real HTTPS server on this machine with a certificate made for the test,
// and the real `fetch` of this Node. What the fake `fetch` of the other tests cannot show: that a certificate nobody trusts is
// refused, that a redirect is not followed, and what a real response looks like once it is cut and cleaned. The server needs
// nothing but `openssl`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { TestContext } from "node:test";
import tls from "node:tls";
import { ok } from "../support/harness.ts";
import type { Harness } from "../support/harness.ts";
import { realHarness } from "../support/real.ts";

function haveOpenssl(): boolean {
    try {
        execFileSync("openssl", ["version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

describe("jig-ops health by address against a real HTTPS server", {
    skip: haveOpenssl() ? false : "openssl is not installed",
}, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-ops-health-"));
    let server: https.Server;
    let origin: string;
    let closedPort = 0;
    let certificate: string;
    const sockets = new Set<import("node:net").Socket>();

    const routes: Record<string, (res: import("node:http").ServerResponse) => void> = {
        "/health": (res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"status":"UP"}');
        },
        "/down": (res) => {
            res.writeHead(503, { "content-type": "application/json" });
            res.end('{"status":"DOWN"}');
        },
        "/moved": (res) => {
            res.writeHead(302, { location: "https://elsewhere.example.test/health?token=hunter2" });
            res.end("moved");
        },
        "/big": (res) => {
            res.writeHead(200);
            res.end("x".repeat(6000));
        },
        "/escape": (res) => {
            res.writeHead(200);
            res.end("ok \u001b[31mred\u001b[0m \u0007bell\u001b]0;title\u0007");
        },
        "/binary": (res) => {
            res.writeHead(200);
            res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
        },
        "/hang": () => {
            // Never answers.
        },
    };

    const section = () => ({
        services: {
            web: {
                environments: Object.fromEntries(
                    ["up", "down", "moved", "big", "escape", "binary", "hang", "query"].map((name) => {
                        const route =
                            name === "up" ? "/health" : name === "query" ? "/health?token=hunter2" : `/${name}`;
                        return [name, { health: `${origin}${route}` }];
                    }),
                ),
            },
            closed: { environments: { gone: { health: `https://127.0.0.1:${closedPort}/health` } } },
        },
    });
    const harness = (t: TestContext): Harness => {
        const h = realHarness(t, section());
        h.jig.setKinds({
            up: "test",
            down: "test",
            moved: "test",
            big: "test",
            escape: "test",
            binary: "test",
            hang: "test",
            query: "test",
            gone: "test",
        });
        return h;
    };
    const check = (h: Harness, environment: string, service = "web") =>
        h.runtime.call({ action: "health", service, environment });

    before(async () => {
        execFileSync(
            "openssl",
            [
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "2",
                "-keyout",
                path.join(dir, "key.pem"),
                "-out",
                path.join(dir, "cert.pem"),
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost,IP:127.0.0.1",
            ],
            { stdio: "ignore" },
        );
        certificate = readFileSync(path.join(dir, "cert.pem"), "utf8");
        server = https.createServer({ key: readFileSync(path.join(dir, "key.pem")), cert: certificate }, (req, res) =>
            (routes[(req.url ?? "").split("?")[0] ?? ""] ?? ((r) => r.writeHead(404).end()))(res),
        );
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
        // A port that nothing listens on: `fetch` refuses some low ports before it connects, so one is taken from the system.
        const spare = createServer();
        await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
        closedPort = (spare.address() as AddressInfo).port;
        await new Promise<void>((resolve) => spare.close(() => resolve()));
    });

    after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
    });

    test("a certificate nobody trusts is refused, and the message says checks are never turned off", async (t) => {
        const h = harness(t);
        const result = await check(h, "up");
        assert.equal(
            result.error?.message,
            `GET ${origin}/health: the TLS certificate was not accepted (DEPTH_ZERO_SELF_SIGNED_CERT); certificate checks are never turned off`,
        );
    });

    // From here the certificate is trusted, as a company's authority would be through NODE_EXTRA_CA_CERTS.
    test("once its authority is trusted, the status and the body of a healthy service come back", async (t) => {
        tls.setDefaultCACertificates([...tls.getCACertificates("default"), certificate]);
        const h = harness(t);
        const result = await check(h, "up");
        assert.equal(ok(result), `GET ${origin}/health -> HTTP 200\n{"status":"UP"}`);
        assert.deepEqual(result.cls, { action: "health", environment: "up", effect: "read" });
    });

    test("a status that is not 2xx is a result, not an error", async (t) => {
        assert.equal(ok(await check(harness(t), "down")), `GET ${origin}/down -> HTTP 503\n{"status":"DOWN"}`);
    });

    test("a redirect is not followed, and the text says where it points", async (t) => {
        const text = ok(await check(harness(t), "moved"));
        assert.match(
            text,
            /^GET .*\/moved -> HTTP 302 \(a redirect, not followed; it points to https:\/\/elsewhere\.example\.test\/health\?token=hunter2\)\nmoved$/,
        );
    });

    test("the query of the address, which can hold a token, is never put in a message", async (t) => {
        const text = ok(await check(harness(t), "query"));
        assert.match(text, /^GET .*\/health\?… -> HTTP 200/);
        assert.ok(!text.includes("hunter2") || text.includes("it points to"), text);
    });

    test("only the first 4 KiB of a long body is read, and the text says there is more", async (t) => {
        const text = ok(await check(harness(t), "big"));
        const lines = text.split("\n");
        assert.equal(lines[1]?.length, 4096);
        assert.equal(lines[2], "[the body goes on; only the first 4096 bytes are shown]");
    });

    test("terminal sequences and control characters are taken out of what the service said", async (t) => {
        const text = ok(await check(harness(t), "escape"));
        assert.ok(!/[\u0000-\u0008\u001b]/.test(text), JSON.stringify(text));
        assert.match(text, /\nok .*red.*bell/);
    });

    test("a body that is not text is not shown", async (t) => {
        assert.match(ok(await check(harness(t), "binary")), /\n\(not text: 7 bytes read\)$/);
    });

    test("a service that never answers is told after ten seconds, in this plugin's words", {
        timeout: 30_000,
    }, async (t) => {
        const result = await check(harness(t), "hang");
        assert.equal(result.error?.message, `GET ${origin}/hang: no answer within 10 s`);
    });

    test("an address nothing listens on is told as refused", async (t) => {
        const result = await check(harness(t), "gone", "closed");
        assert.equal(
            result.error?.message,
            `GET https://127.0.0.1:${closedPort}/health: the connection was refused (ECONNREFUSED)`,
        );
    });
});
