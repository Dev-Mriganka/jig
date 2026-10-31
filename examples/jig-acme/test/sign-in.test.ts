// `acme-sso`, the sign-in service: it adds a bearer header read from a secret reference, to Acme's hosts only. Tested alone, and then
// through the real jig-core, which asks it for every request, hides what it returns from every result, and removes it from a reply
// that echoes it. The server is a fake on this machine.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createSsoService, SSO_SERVICE } from "../src/signin.ts";
import type { SignInRequest } from "../src/jig/types.ts";
import { call } from "./support/call.ts";
import { fakePrograms } from "./support/programs.ts";
import type { FakePrograms } from "./support/programs.ts";
import { fakeServer } from "./support/servers.ts";
import type { FakeServer } from "./support/servers.ts";
import { startWorld } from "./support/world.ts";
import type { World } from "./support/world.ts";

// Built at run time, like every fake credential in this repository.
const TOKEN = ["sso", "token", "value", "0123456789"].join("-");

const request = (url: string, over: Partial<SignInRequest> = {}): SignInRequest => ({
    system: "logs",
    url,
    method: "GET",
    headers: {},
    ...over,
});

describe("the service on its own", () => {
    const service = (hosts: readonly string[]) =>
        createSsoService({ reference: () => "env:X", resolve: async () => TOKEN, hosts });

    test("adds Authorization: Bearer <token>, and nothing else", async () => {
        const headers = await service([".acme.example"]).headers(request("https://logs.acme.example/_search"));
        assert.deepEqual(headers, { Authorization: `Bearer ${TOKEN}` });
    });

    test("reads the secret reference it is given, each time it is asked", async () => {
        const asked: string[] = [];
        let reference = "env:ONE";
        const sso = createSsoService({
            reference: () => reference,
            resolve: async (ref) => {
                asked.push(ref);
                return TOKEN;
            },
            hosts: [".acme.example"],
        });
        await sso.headers(request("https://logs.acme.example/a"));
        reference = "env:TWO";
        await sso.headers(request("https://logs.acme.example/b"));
        assert.deepEqual(asked, ["env:ONE", "env:TWO"]);
    });

    test("serves Acme's hosts and nobody else's", async () => {
        const sso = service([".acme.example", "acme.atlassian.net"]);
        for (const url of ["https://logs.acme.example/_search", "https://acme.atlassian.net/rest/api/3/myself"]) {
            await sso.headers(request(url));
        }
        for (const url of [
            "https://acme.example/",
            "https://logs.acme.example.evil.example/",
            "https://logs.acme.example@evil.example/",
            "https://evil.example/logs.acme.example",
            "https://other.atlassian.net/",
            "not a url",
        ]) {
            await assert.rejects(sso.headers(request(url)), /Acme hosts only/, url);
        }
    });

    test("never sends a token in clear text across a network: http only to this machine, and only if it is listed", async () => {
        await assert.rejects(
            service([".acme.example"]).headers(request("http://logs.acme.example/")),
            /Acme hosts only/,
        );
        await assert.rejects(
            service([".acme.example"]).headers(request("ftp://logs.acme.example/")),
            /Acme hosts only/,
        );
        await assert.rejects(service([".acme.example"]).headers(request("http://127.0.0.1:9/")), /Acme hosts only/);
        assert.deepEqual(await service(["127.0.0.1"]).headers(request("http://127.0.0.1:9/")), {
            Authorization: `Bearer ${TOKEN}`,
        });
    });

    test("a refusal names no address, and never the token", async () => {
        const failure = await service([".acme.example"])
            .headers(request("https://evil.example/path?secret=1"))
            .then(
                () => undefined,
                (error: Error) => error,
            );
        assert.ok(failure);
        assert.equal(failure.message.includes("evil.example"), false);
        assert.equal(failure.message.includes(TOKEN), false);
    });
});

describe("through jig-core", () => {
    let server: FakeServer;
    let world: World | undefined;
    const saved = process.env.ACME_TEST_SSO_TOKEN;
    beforeEach(async () => {
        server = await fakeServer();
        process.env.ACME_TEST_SSO_TOKEN = TOKEN;
    });
    afterEach(async () => {
        await world?.close();
        world = undefined;
        await server.close();
        if (saved === undefined) delete process.env.ACME_TEST_SSO_TOKEN;
        else process.env.ACME_TEST_SSO_TOKEN = saved;
    });

    /** A user who points `acme.sso.token` at a variable, and allows that secret backend: only a user can. */
    const personal = {
        secrets: { backends: ["pass", "env"] },
        acme: { sso: { token: "env:ACME_TEST_SSO_TOKEN" } },
    };

    test("a request that names the service carries the bearer header the server sees", async () => {
        world = await startWorld({ personal, acme: { hosts: ["127.0.0.1"] } });
        const reply = await world.api.http.request({
            system: "logs",
            url: `${server.address}/acme-logs-dev-*/_search`,
            method: "GET",
            auth: { signIn: SSO_SERVICE },
        });
        assert.equal(reply.status, 200);
        assert.equal(server.seen.length, 1);
        assert.equal(server.seen[0]?.headers.authorization, `Bearer ${TOKEN}`);
    });

    test("a server that echoes the header does not get the token back into the result", async () => {
        world = await startWorld({ personal, acme: { hosts: ["127.0.0.1"] } });
        server.reply((seen) => ({ body: `you sent ${String(seen.headers.authorization)}` }));
        const reply = await world.api.http.request({
            system: "logs",
            url: `${server.address}/echo`,
            method: "GET",
            auth: { signIn: SSO_SERVICE },
        });
        assert.equal(reply.body.includes(TOKEN), false, reply.body);
        assert.match(reply.body, /\[redacted\]/);
    });

    test("and the token is hidden from any later tool result as well", async () => {
        world = await startWorld({ personal, acme: { hosts: ["127.0.0.1"] } });
        await world.api.http.request({
            system: "logs",
            url: `${server.address}/anything`,
            method: "GET",
            auth: { signIn: SSO_SERVICE },
        });
        world.api.declareTool({
            tool: "echo_tool",
            plugin: "jig-acme-test",
            classify: () => ({ environment: "local", effect: "read" }),
        });
        const outcome = await call(world, "echo_tool", {}, `the log said ${TOKEN} by mistake`);
        assert.equal(outcome.text.includes(TOKEN), false, outcome.text);
    });

    test("a request for a host that is not Acme's is refused before anything is sent", async () => {
        // The default hosts: the fake server is on 127.0.0.1, which is not Acme's.
        world = await startWorld({ personal });
        await assert.rejects(
            world.api.http.request({
                system: "logs",
                url: `${server.address}/steal`,
                method: "GET",
                auth: { signIn: SSO_SERVICE },
            }),
            (error: Error & { code?: string; notSent?: boolean }) => {
                assert.equal(error.code, "auth_failed");
                assert.equal(error.notSent, true);
                assert.match(error.message, /Acme hosts only/);
                return true;
            },
        );
        assert.deepEqual(server.seen, []);
    });

    test("with no setting of the user's, the token comes from the company's command: the company turned `cmd` on", async () => {
        const programs: FakePrograms = fakePrograms();
        const path = process.env.PATH;
        process.env.PATH = `${programs.bin}:${path ?? ""}`;
        try {
            world = await startWorld({ acme: { hosts: ["127.0.0.1"] } });
            server.reply((seen) => ({ body: String(seen.headers.authorization) }));
            const reply = await world.api.http.request({
                system: "logs",
                url: `${server.address}/who`,
                method: "GET",
                auth: { signIn: SSO_SERVICE },
            });
            // The fake `acme` prints this value; the server saw it as the bearer token, and the reply echoed it, redacted.
            assert.equal(server.seen[0]?.headers.authorization, "Bearer acme-cli-token-value-0123456789");
            assert.equal(reply.body.includes("acme-cli-token-value"), false);
        } finally {
            if (path === undefined) delete process.env.PATH;
            else process.env.PATH = path;
            programs.close();
        }
    });

    test("a user who turned `cmd` off keeps it off: the company's command is not run, and the message says who turned it off", async () => {
        world = await startWorld({
            personal: { secrets: { disabledBackends: ["cmd"] } },
            acme: { hosts: ["127.0.0.1"] },
        });
        await assert.rejects(
            world.api.http.request({
                system: "logs",
                url: `${server.address}/who`,
                method: "GET",
                auth: { signIn: SSO_SERVICE },
            }),
            (error: Error & { code?: string; notSent?: boolean }) => {
                assert.equal(error.code, "auth_failed");
                assert.equal(error.notSent, true);
                assert.match(error.message, /cmd/, "the message says which backend is off");
                assert.match(error.message, /disabledBackends/, "and that the user turned it off");
                return true;
            },
        );
        assert.deepEqual(server.seen, []);
    });
});
