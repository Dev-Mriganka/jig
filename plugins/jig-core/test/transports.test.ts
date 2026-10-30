// Transports: a company plugin carries requests to its own systems, and a tool sends through it by name.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TransportRequest } from "../src/contract.ts";
import { createTransports } from "../src/transports.ts";

const REQUEST: TransportRequest = { system: "logs", method: "POST", url: "https://logs.example.com/app-*/_search", body: "{}" };

describe("transports", () => {
    test("carry a request through the registered transport, with header names in lower case", async () => {
        const transports = createTransports();
        const seen: TransportRequest[] = [];
        transports.register("company", {
            request: async (request) => {
                seen.push(request);
                return { status: 200, headers: { "Content-Type": "application/json" }, body: "{\"hits\":{}}" };
            },
        });
        const response = await transports.request("company", REQUEST);
        assert.deepEqual(seen, [REQUEST]);
        assert.deepEqual(response, { status: 200, headers: { "content-type": "application/json" }, body: "{\"hits\":{}}" });
    });

    test("an unknown name is an error that lists the registered ones", async () => {
        const transports = createTransports();
        await assert.rejects(transports.request("missing", REQUEST), /no transport named "missing" \(none is registered\)/);
        transports.register("one", { request: async () => ({ status: 200, headers: {}, body: "" }) });
        await assert.rejects(transports.request("missing", REQUEST), /registered: one/);
    });

    test("registering a name again replaces the transport", async () => {
        const transports = createTransports();
        transports.register("t", { request: async () => ({ status: 500, headers: {}, body: "old" }) });
        transports.register("t", { request: async () => ({ status: 200, headers: {}, body: "new" }) });
        assert.equal((await transports.request("t", REQUEST)).body, "new");
    });

    test("a transport's mistakes are caught where they are made", async () => {
        const transports = createTransports();
        assert.throws(() => transports.register("", { request: async () => ({ status: 200, headers: {}, body: "" }) }), TypeError);
        assert.throws(() => transports.register("t", {} as never), /must have a request function/);
        for (const [bad, message] of [
            [undefined, /returned no response/],
            [{ status: 42, headers: {}, body: "" }, /valid HTTP status/],
            [{ status: 200, headers: {}, body: 5 }, /body is not text/],
            [{ status: 200, headers: [], body: "" }, /headers that are not an object/],
            [{ status: 200, headers: { a: 1 }, body: "" }, /header \(a\) that is not text/],
        ] as const) {
            transports.register("bad", { request: async () => bad as never });
            await assert.rejects(transports.request("bad", REQUEST), message);
        }
    });

    test("a failing transport is named in the error, and the request is not repeated in it", async () => {
        const transports = createTransports();
        transports.register("proxy", { request: async () => { throw new Error("proxy is not running"); } });
        await assert.rejects(transports.request("proxy", { ...REQUEST, body: "{\"customer\":\"jane@example.com\"}" }), (error: Error) => {
            assert.match(error.message, /transport "proxy" failed: proxy is not running/);
            assert.doesNotMatch(error.message, /jane@example\.com|_search/);
            return true;
        });
    });
});
