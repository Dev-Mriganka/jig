// `acme-gateway`, the transport: it hands a whole request to a corporate gateway on this machine, which is asked as an HTTP proxy
// is, and returns the gateway's answer. The gateway here is a fake server on 127.0.0.1 that records what it was asked.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createGatewayTransport, GATEWAY_TRANSPORT } from "../src/transport.ts";
import { fakeServer } from "./support/servers.ts";
import type { FakeServer } from "./support/servers.ts";
import { startWorld } from "./support/world.ts";
import type { World } from "./support/world.ts";

let gateway: FakeServer;
let world: World | undefined;
beforeEach(async () => {
    gateway = await fakeServer();
});
afterEach(async () => {
    await world?.close();
    world = undefined;
    await gateway.close();
});

const ORDERS = "https://orders-api.staging.acme.example/v1/orders?page=2";

describe("the transport on its own", () => {
    const transport = () => createGatewayTransport({ proxy: () => new URL(gateway.address), hosts: [".acme.example"] });

    test("asks the gateway for the full address, and returns its status, lower-case headers and text", async () => {
        gateway.reply(() => ({
            status: 201,
            headers: { "Content-Type": "application/json", "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"] },
            body: '{"id":7}',
        }));
        const reply = await transport().request({
            system: "api:acme",
            method: "POST",
            url: ORDERS,
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: '{"sku":"A-1"}',
        });
        const seen = gateway.seen[0];
        assert.equal(seen?.method, "POST");
        assert.equal(seen?.url, ORDERS, "the request line carries the whole address, as a proxy is asked");
        assert.equal(seen?.headers.host, "orders-api.staging.acme.example");
        assert.equal(seen?.headers.accept, "application/json");
        assert.equal(seen?.headers["content-length"], "13");
        assert.equal(seen?.body, '{"sku":"A-1"}');
        assert.equal(reply.status, 201);
        assert.equal(reply.headers["content-type"], "application/json");
        assert.equal(reply.headers["set-cookie"], "a=1; Path=/, b=2; Path=/");
        assert.equal(reply.body, '{"id":7}');
    });

    test("does not pass on a Host or Content-Length of the caller's, or a proxy credential", async () => {
        await transport().request({
            system: "api:acme",
            method: "GET",
            url: ORDERS,
            headers: {
                Host: "evil.example",
                "Content-Length": "999",
                "Proxy-Authorization": "Basic x",
                "X-Trace": "t-1",
            },
        });
        const headers = gateway.seen[0]?.headers ?? {};
        assert.equal(headers.host, "orders-api.staging.acme.example");
        assert.equal(headers["content-length"], undefined);
        assert.equal(headers["proxy-authorization"], undefined);
        assert.equal(headers["x-trace"], "t-1");
    });

    test("carries an error status as an answer", async () => {
        gateway.reply(() => ({ status: 503, body: "busy" }));
        const reply = await transport().request({ system: "api:acme", method: "GET", url: ORDERS });
        assert.deepEqual([reply.status, reply.body], [503, "busy"]);
    });

    test("serves Acme's hosts only, and sends nothing for another", async () => {
        for (const url of [
            "https://evil.example/v1",
            "https://acme.example/v1",
            "http://orders-api.acme.example/v1",
            "nonsense",
        ]) {
            await assert.rejects(
                transport().request({ system: "api:acme", method: "GET", url }),
                /Acme hosts only/,
                url,
            );
        }
        assert.deepEqual(gateway.seen, []);
    });

    test("a gateway that is down is one line with its code, and the address is not in it", async () => {
        await gateway.close();
        const down = createGatewayTransport({ proxy: () => new URL(gateway.address), hosts: [".acme.example"] });
        const failure = await down.request({ system: "api:acme", method: "GET", url: ORDERS }).then(
            () => undefined,
            (error: Error) => error,
        );
        assert.match(failure?.message ?? "", /^the gateway could not be reached \(ECONNREFUSED\)$/);
        gateway = await fakeServer();
    });

    test("stops when the call is cancelled", async () => {
        gateway.reply(() => ({ hang: true }));
        const controller = new AbortController();
        const pending = transport().request({ system: "api:acme", method: "GET", url: ORDERS }, controller.signal);
        setTimeout(() => controller.abort(), 50);
        await assert.rejects(pending, (error: Error) => error.name === "AbortError");
    });
});

describe("through jig-core", () => {
    const personal = () => ({ acme: { gateway: { proxy: gateway.address } } });

    test("a request that names the transport reaches the gateway, and its answer comes back as an HTTP answer", async () => {
        world = await startWorld({ personal: personal() });
        gateway.reply(() => ({ status: 200, headers: { "Content-Type": "application/json" }, body: '{"ok":true}' }));
        const reply = await world.api.http.request({
            system: "api:acme",
            url: ORDERS,
            method: "GET",
            headers: { Accept: "application/json" },
            transport: GATEWAY_TRANSPORT,
        });
        assert.equal(gateway.seen[0]?.url, ORDERS);
        assert.equal(reply.status, 200);
        assert.equal(reply.body, '{"ok":true}');
        assert.equal(reply.headers["content-type"], "application/json");
    });

    test("jig-core's own call to a transport reaches it too", async () => {
        world = await startWorld({ personal: personal() });
        const reply = await world.api.transports.request(GATEWAY_TRANSPORT, {
            system: "logs",
            method: "GET",
            url: ORDERS,
        });
        assert.equal(reply.status, 200);
        assert.equal(gateway.seen.length, 1);
    });

    test("a request for a host that is not Acme's fails as a transport failure, and the gateway is never asked", async () => {
        world = await startWorld({ personal: personal() });
        await assert.rejects(
            world.api.http.request({
                system: "api:acme",
                url: "https://evil.example/x",
                method: "GET",
                transport: GATEWAY_TRANSPORT,
            }),
            (error: Error & { code?: string }) => {
                assert.equal(error.code, "transport_failed");
                assert.match(error.message, /Acme hosts only/);
                return true;
            },
        );
        assert.deepEqual(gateway.seen, []);
    });

    test("the saved API requests of the staging environment go through it: that is what the api default says", async () => {
        world = await startWorld({ personal: personal() });
        const staging = (world.api.config.section("api") as { environments: Record<string, unknown> }).environments
            .Staging;
        assert.deepEqual(staging, { environment: "staging", transport: GATEWAY_TRANSPORT });
    });
});

describe("the gateway's address, a setting of the user's", () => {
    test("must be on this machine, and plain http: the request is sent in clear text", async () => {
        for (const proxy of [
            "http://proxy.acme.example:3128",
            "https://127.0.0.1:3128",
            "http://user:pw@127.0.0.1:3128",
            "nonsense",
        ]) {
            world = await startWorld({ personal: { acme: { gateway: { proxy } } } });
            const problems = (await world.problems()).join("\n");
            assert.match(problems, /acme\.gateway\.proxy: must be an http address on this machine/, proxy);
            assert.equal(problems.includes("pw"), false, "a password in the address is not repeated");
            await world.close();
        }
        world = undefined;
    });

    test("is local by default, and any local name is fine", async () => {
        for (const proxy of ["http://127.0.0.1:3128", "http://localhost:8080", "http://[::1]:3128"]) {
            world = await startWorld({ personal: { acme: { gateway: { proxy } } } });
            assert.deepEqual(await world.problems(), [], proxy);
            await world.close();
        }
        world = undefined;
    });
});
