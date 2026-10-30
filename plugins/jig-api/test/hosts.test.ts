// Hosts are pinned per environment: the hosts that an environment's addresses come to are the only hosts a request in it may
// reach. A request with a host of its own is refused unless the environment holds the same one, and the addresses of a cloud
// machine's metadata and of this machine are refused whatever the environment says.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { useAcme } from "./support/acme.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());
beforeEach(() => h.reset());

/** One Postman collection of requests by name and address, with an environment `Staging` of the given values. */
function collection(
    requests: Record<string, string>,
    values: Record<string, string>,
    extra: Record<string, unknown> = {},
    auth?: unknown,
): void {
    const file = path.join(h.dir, "pinned.postman_collection.json");
    fs.writeFileSync(
        file,
        JSON.stringify({
            info: { name: "Pinned" },
            ...(auth === undefined ? {} : { auth }),
            item: Object.entries(requests).map(([name, url]) => ({
                name,
                request: { method: "GET", url: { raw: url } },
            })),
        }),
    );
    const env = path.join(h.dir, "pinned-staging.json");
    fs.writeFileSync(
        env,
        JSON.stringify({ values: Object.entries(values).map(([key, value]) => ({ key, value, enabled: true })) }),
    );
    h.configure({
        collections: { pinned: { postman: file, environments: { Staging: env, Qa: env } } },
        environments: { Staging: "staging", Qa: "qa" },
        allowPlainLocal: true,
        ...extra,
    });
}
const run = (request: string, extra: Record<string, unknown> = {}) =>
    h.call({ action: "run", request, environment: "Staging", ...extra });

describe("the environment decides the host", () => {
    test("a request goes to the host its environment gives it, and the other environment's host stays untouched", async () => {
        useAcme(h);
        ok(await h.call({ action: "run", request: "Health", collection: "acme", environment: "Staging" }));
        ok(await h.call({ action: "run", request: "Health", collection: "acme", environment: "Production" }));
        assert.deepEqual([h.api.requests.length, h.prod.requests.length], [1, 1]);
    });

    test("a host written in the request is allowed when the environment holds the same one, and in no other environment", async () => {
        collection({ Variable: "{{baseUrl}}/a", Literal: `${h.api.origin}/b` }, { baseUrl: h.api.origin });
        ok(await run("Variable"));
        ok(await run("Literal"));
        assert.deepEqual(
            h.api.requests.map((r) => r.path),
            ["/a", "/b"],
        );
        collection({ Variable: "{{baseUrl}}/a", Literal: `${h.api.origin}/b` }, { baseUrl: h.prod.origin });
        const refused = await run("Literal");
        assert.match(
            refused.blocked ?? "",
            /^jig-core could not decide: the address of "Literal" goes to 127\.0\.0\.1:\d+, which is not a host of Staging \(127\.0\.0\.1:\d+\); a request takes its host from its environment, such as \{\{baseUrl\}\}$/,
        );
        assert.equal(h.api.requests.length, 2, "the host the environment moved away from saw nothing more");
    });

    test("a request with another host entirely is refused with the hosts the environment has", async () => {
        useAcme(h);
        const refused = await h.call({
            action: "run",
            request: "Other host",
            collection: "acme",
            environment: "Staging",
        });
        assert.match(
            refused.blocked ?? "",
            /^jig-core could not decide: the address of "Other host" goes to api\.other\.example\.test, which is not a host of Staging \(/,
        );
        const ledger = await h.call({
            action: "run",
            request: "Other host",
            collection: "ledger",
            environment: "staging",
        });
        assert.match(ledger.blocked ?? "", /which is not a host of staging/);
        assert.equal(h.api.requests.length + h.prod.requests.length, 0);
    });

    test("an environment that gives no request a host from a variable has no hosts: nothing runs, and the reason says what to do", async () => {
        collection({ Literal: `${h.api.origin}/b` }, { baseUrl: h.api.origin });
        const result = await run("Literal");
        assert.match(
            result.blocked ?? "",
            /which is not a host of Staging \(none \(no request takes its host from a variable of the environment\)\); a request takes its host from its environment/,
        );
        assert.equal(h.api.requests.length, 0);
    });

    test("a variable that is missing only from the path does not take the host away", async () => {
        collection({ Only: "{{baseUrl}}/orders/{{orderId}}" }, { baseUrl: h.api.origin });
        ok(await run("Only", { variables: { orderId: "1" } }));
        assert.equal(h.api.requests[0]?.path, "/orders/1");
    });

    test("a host built from several variables is checked once they are filled in", async () => {
        const url = new URL(h.api.origin);
        collection(
            { Parts: "{{scheme}}://{{host}}:{{port}}/p" },
            { scheme: "http", host: url.hostname, port: url.port },
        );
        ok(await run("Parts"));
        assert.equal(h.api.requests.length, 1);
    });

    test("the agent cannot give any part of the host, however the address is put together", async () => {
        const url = new URL(h.api.origin);
        collection(
            { Parts: "{{scheme}}://{{host}}:{{port}}/p/{{id}}", Sub: "http://{{sub}}{{domain}}:{{port}}/q" },
            { scheme: "http", host: url.hostname, port: url.port, domain: ".localhost" },
        );
        for (const [request, variables, name] of [
            ["Parts", { host: "evil.example.test", id: "1" }, "host"],
            ["Parts", { scheme: "https", id: "1" }, "scheme"],
            ["Parts", { port: "1", id: "1" }, "port"],
            ["Sub", { sub: "evil" }, "sub"],
        ] as const) {
            const result = await run(request, { variables });
            assert.match(
                result.blocked ?? "",
                new RegExp(
                    `${name} would set the host of the request: the host comes from the environment, not from the call`,
                ),
                `${request} ${name}`,
            );
        }
        assert.equal(h.api.requests.length, 0);
    });

    test("the port is part of the host", async () => {
        collection(
            { Variable: "{{baseUrl}}/a", Elsewhere: `http://127.0.0.1:${Number(new URL(h.api.origin).port) + 1}/b` },
            { baseUrl: h.api.origin },
        );
        assert.match((await run("Elsewhere")).blocked ?? "", /which is not a host of Staging/);
    });

    test("the way a host is written does not matter: its case and a default port", async () => {
        collection(
            {
                Variable: "{{baseUrl}}/a",
                Upper: `HTTP://${new URL(h.api.origin).host.toUpperCase()}/c`,
                Secure: "{{secure}}/s",
            },
            { baseUrl: h.api.origin, secure: "https://API.Example.test:443" },
        );
        ok(await run("Upper"));
        assert.equal(h.api.requests[0]?.path, "/c");
        // The environment's second host is written in capitals and with its default port; a request written plainly matches it.
        collection(
            { Secure: "{{secure}}/s", Plain: "https://api.example.test/p" },
            { secure: "https://API.Example.test:443" },
            { allowPlainLocal: true },
        );
        // Classifying plans the request, host check included, and sends nothing.
        assert.doesNotThrow(
            () => h.declaration.classify({ action: "run", request: "Plain", environment: "Staging" }),
            "the same host, however it is written",
        );
    });
});

describe("the token endpoint is one of the environment's hosts too", () => {
    const oauth = (tokenUrl: string) => ({
        type: "oauth2",
        oauth2: [
            { key: "grant_type", value: "client_credentials" },
            { key: "accessTokenUrl", value: tokenUrl },
            { key: "clientId", value: "c" },
            { key: "clientSecret", value: "{{clientSecret}}" },
        ],
    });

    test("an endpoint on a host the environment gives is used", async () => {
        collection(
            { Stock: "{{baseUrl}}/stock" },
            { baseUrl: h.api.origin, authUrl: h.auth.origin, clientSecret: "" },
            { secrets: { clientSecret: "pass:api/client-secret" } },
            oauth("{{authUrl}}/oauth/token"),
        );
        ok(await run("Stock"));
        assert.equal(h.auth.requests.length, 1);
    });

    test("an endpoint on any other host is refused, and the client's secret is not sent there", async () => {
        collection(
            { Stock: "{{baseUrl}}/stock" },
            { baseUrl: h.api.origin, clientSecret: "" },
            { secrets: { clientSecret: "pass:api/client-secret" } },
            oauth(`${h.auth.origin}/oauth/token`),
        );
        const result = await run("Stock");
        assert.match(
            result.blocked ?? "",
            /^jig-core could not decide: the token address of "Stock" goes to 127\.0\.0\.1:\d+, which is not a host of Staging/,
        );
        assert.equal(h.auth.requests.length, 0);
        assert.deepEqual(h.jig.secretCalls, []);
    });
});

describe("addresses that are never called", () => {
    test("a metadata or link-local address is refused even when the environment itself gives it", async () => {
        for (const base of [
            "http://169.254.169.254",
            "https://169.254.169.254",
            "https://metadata.google.internal",
            "https://[fd00:ec2::254]",
            "https://[::ffff:169.254.169.254]",
        ]) {
            collection({ Meta: "{{baseUrl}}/latest/meta-data/" }, { baseUrl: base });
            const result = await run("Meta");
            assert.match(
                result.blocked ?? "",
                /^jig-core could not decide: the address of "Meta": the address is (?:a link-local or cloud metadata address|a cloud metadata address|a link-local address), which is never called$/,
                base,
            );
        }
    });

    test("this machine is refused unless the configuration allows it, and other forms of it never", async () => {
        collection({ Local: "{{baseUrl}}/x" }, { baseUrl: h.api.origin }, { allowPlainLocal: false });
        assert.match(
            (await run("Local")).blocked ?? "",
            /the address is this machine, which needs "allowPlainLocal": true in the api section/,
        );
        for (const base of [
            "https://localhost",
            "https://127.0.0.1:9",
            "http://[::1]:9",
            "http://127.0.0.2:9",
            "http://0.0.0.0:9",
        ]) {
            collection({ Local: "{{baseUrl}}/x" }, { baseUrl: base }, { allowPlainLocal: false });
            assert.match(
                (await run("Local")).blocked ?? "",
                /the address (?:is this machine|is a form of this machine)/,
                base,
            );
        }
        collection({ Local: "{{baseUrl}}/x" }, { baseUrl: "http://127.0.0.2:9" }, { allowPlainLocal: true });
        assert.match(
            (await run("Local")).blocked ?? "",
            /is a form of this machine other than 127\.0\.0\.1 and localhost, which is never called/,
        );
    });

    test("plain http to a remote host is refused", async () => {
        collection({ Plain: "{{baseUrl}}/x" }, { baseUrl: "http://api.staging.example.test" });
        assert.match(
            (await run("Plain")).blocked ?? "",
            /the address must be an https address \(plain http is only for 127\.0\.0\.1 and localhost/,
        );
    });

    test("an address with a user name or a password in it is refused", async () => {
        collection({ Userinfo: "{{baseUrl}}/x" }, { baseUrl: "https://jane:secret@api.staging.example.test" });
        const result = await run("Userinfo");
        assert.match(result.blocked ?? "", /the address must not contain a user name or password/);
        assert.ok(!(result.blocked ?? "").includes("secret@"), "the password is not repeated");
    });

    test("the sending function asks again for every request, whatever plan it was given", async () => {
        const { exchange, NotSentError } = await import("../src/engine/wire.ts");
        for (const url of ["http://169.254.169.254/latest/", "https://169.254.169.254/", "http://127.0.0.1:1/x"]) {
            await assert.rejects(
                exchange(
                    { system: "api", method: "GET", url, headers: {}, allowPlainLocal: !url.startsWith("http://127") },
                    new AbortController().signal,
                ),
                (error: unknown) => error instanceof NotSentError && /^the address is refused \(/.test(error.message),
                url,
            );
        }
    });
});
