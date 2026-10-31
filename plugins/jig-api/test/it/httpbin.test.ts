// jig-api against a real HTTP server, go-httpbin, which answers every request with what it received. The example company's
// collections (Postman, `.http`, Bruno in both formats, OpenAPI in both) are copied with their API address pointed at httpbin's
// `/anything`, so a saved request is run by name and the answer shows exactly what reached the wire: the method, the address, the
// headers, the JSON, the form and the uploaded file. The engine is also tried on its own with ad-hoc calls: every method, a
// redirect that is not followed, cookies that are not kept, and an answer cut at its cap.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { describeIt, must } from "../../../../test/support/it.ts";
import { useAcme, useBruno, useOpenApi } from "../support/acme.ts";
import { ok, setupHarness } from "../support/harness.ts";
import type { Harness } from "../support/harness.ts";

/** What httpbin saw, read from the body of a result. */
interface Echo {
    method: string;
    url: string;
    headers: Record<string, string[]>;
    args: Record<string, string[]>;
    form: Record<string, string[]>;
    files: Record<string, string[]>;
    json: unknown;
    data: string;
}

function echoOf(text: string): Echo {
    const start = text.indexOf("\n\n");
    assert.ok(start >= 0, `the result has a body:\n${text.slice(0, 400)}`);
    return JSON.parse(text.slice(start + 2));
}

describeIt(
    "jig-api against go-httpbin",
    {
        service: "httpbin",
        variables: ["JIG_IT_HTTPBIN_URL"],
        hint: "go-httpbin with MAX_BODY_SIZE=8388608 (set JIG_IT_HTTPBIN_URL=http://127.0.0.1:8081)",
    },
    () => {
        let h: Harness;
        const origin = () => must("JIG_IT_HTTPBIN_URL").replace(/\/$/, "");

        before(async () => {
            h = await setupHarness();
            const version = await fetch(`${origin()}/get`).then((reply) => reply.headers.get("server") ?? "httpbin");
            console.log(`go-httpbin at ${origin()} (${version})`);
        });
        after(() => h.close());

        /** Every saved request here goes to `/anything` on httpbin, which echoes it. */
        function point(use: () => unknown): void {
            h.reset();
            Object.assign(h.api, { origin: `${origin()}/anything` });
            use();
        }

        interface Source {
            label: string;
            use(): unknown;
            collection: string;
            environment: string;
            get: string;
            create: string;
            /** Absent when the collection has no name for its DELETE (a `.http` request without a name). */
            cancel: string | undefined;
            /** What the create request is given, and the JSON that must arrive. */
            createVariables: Record<string, string>;
            created: Record<string, unknown>;
            path: string;
        }
        const sources: Source[] = [
            {
                label: "Postman",
                use: () => useAcme(h),
                collection: "acme",
                environment: "Staging",
                get: "Get order",
                create: "Create order",
                cancel: "Cancel order",
                createVariables: { sku: "sku-9", quantity: "3", note: "hello" },
                created: { customerId: "cust-staging-1", sku: "sku-9", quantity: 3, note: "hello" },
                path: "/anything/v1",
            },
            {
                label: ".http files",
                use: () => useAcme(h),
                collection: "ledger",
                environment: "staging",
                get: "orders.http/Get order",
                create: "orders.http/Create order",
                cancel: undefined,
                createVariables: { sku: "sku-9", quantity: "3" },
                created: { customerId: "cust-staging-1", sku: "sku-9", quantity: 3 },
                path: "/anything/v1",
            },
            ...(["yaml", "bru"] as const).map((format) => ({
                label: `Bruno (${format})`,
                use: () => useBruno(h, format),
                collection: "acme",
                environment: "Staging",
                get: "Orders/Get order",
                create: "Orders/Create order",
                cancel: "Orders/Cancel order",
                createVariables: { sku: "sku-9", quantity: "3" },
                created: { customerId: "cust-staging-1", sku: "sku-9", quantity: 3 },
                path: "/anything/v1",
            })),
            ...(["yaml", "json"] as const).map((format) => ({
                label: `OpenAPI (${format})`,
                use: () => useOpenApi(h, format),
                collection: "acme",
                environment: "Staging",
                get: "Orders/getOrder",
                create: "Orders/createOrder",
                cancel: "Orders/cancelOrder",
                createVariables: { customerId: "cust-7", sku: "sku-9", quantity: "3" },
                created: { customerId: "cust-7", sku: "sku-9", quantity: 3 },
                path: "/anything/v1",
            })),
        ];

        for (const source of sources) {
            describe(`${source.label}: saved requests run against the real server`, () => {
                const where = { collection: source.collection, environment: source.environment };

                test("a read reaches the wire with its path filled and its sign-in added, and the token is removed from the answer", async () => {
                    point(source.use);
                    const result = await h.call({
                        action: "run",
                        request: source.get,
                        ...where,
                        variables: { orderId: "123" },
                    });
                    const text = ok(result);
                    assert.match(
                        text,
                        new RegExp(
                            `^GET ${origin().replace(/[./]/g, "\\$&")}/anything/v1/orders/123 -> HTTP 200 OK\\n`,
                        ),
                    );
                    const seen = echoOf(text);
                    assert.equal(seen.method, "GET");
                    assert.equal(new URL(seen.url).pathname, `${source.path}/orders/123`);
                    assert.deepEqual(
                        seen.headers.Authorization,
                        ["Bearer [redacted]"],
                        "the token was sent, and the tool removed it from what came back",
                    );
                    assert.ok(!text.includes("stg-token-4f9c2a71d3e8"));
                    assert.deepEqual(result.cls, {
                        action: source.get.split("/").pop(),
                        environment: "staging",
                        effect: "read",
                    });
                });

                test("a write is previewed with the exact request, then sent once with its JSON body", async () => {
                    point(source.use);
                    const result = await h.call({
                        action: "run",
                        request: source.create,
                        ...where,
                        variables: source.createVariables,
                    });
                    const text = ok(result);
                    assert.match(result.preview?.body ?? "", /\nMethod: POST\n/);
                    assert.match(result.preview?.fingerprint ?? "", /^[0-9a-f]{32,64}$/);
                    const seen = echoOf(text);
                    assert.equal(seen.method, "POST");
                    assert.deepEqual(seen.json, {
                        ...source.created,
                        ...(typeof (seen.json as { createdAt?: unknown })?.createdAt === "string"
                            ? { createdAt: (seen.json as { createdAt: string }).createdAt }
                            : {}),
                    });
                    assert.match(String(seen.headers["Content-Type"]?.[0]), /^application\/json/);
                    assert.deepEqual(result.cls, {
                        action: source.create.split("/").pop(),
                        environment: "staging",
                        effect: "write",
                    });
                });

                test("DELETE is sent as DELETE", async (t) => {
                    if (source.cancel === undefined)
                        return t.skip("the .http fixture's DELETE has no name to run it by");
                    point(source.use);
                    const seen = echoOf(
                        ok(
                            await h.call({
                                action: "run",
                                request: source.cancel,
                                ...where,
                                variables: { orderId: "55" },
                            }),
                        ),
                    );
                    assert.equal(seen.method, "DELETE");
                    assert.equal(new URL(seen.url).pathname, `${source.path}/orders/55`);
                });
            });
        }

        describe("a form, an upload and a file body from Postman and Bruno collections", () => {
            for (const [label, use] of [
                ["Postman", () => useAcme(h)],
                ["Bruno (yaml)", () => useBruno(h, "yaml")],
                ["Bruno (bru)", () => useBruno(h, "bru")],
            ] as const) {
                test(`${label}: a form body is urlencoded, a file is uploaded as a multipart part, and a file body is sent whole`, async () => {
                    point(use);
                    const prefix = label === "Postman" ? "" : "Orders/";
                    const where = { collection: "acme", environment: "Staging" };
                    const form = echoOf(
                        ok(
                            await h.call({
                                action: "run",
                                request: `${prefix}Place order (form)`,
                                ...where,
                                variables: { note: "n 1&2" },
                            }),
                        ),
                    );
                    assert.deepEqual(form.form.note, ["n 1&2"]);
                    assert.match(String(form.headers["Content-Type"]?.[0]), /^application\/x-www-form-urlencoded/);
                    const upload = echoOf(
                        ok(
                            await h.call({
                                action: "run",
                                request: `${prefix}Upload receipt`,
                                ...where,
                                variables: { orderId: "7", note: "n" },
                            }),
                        ),
                    );
                    const receipt = label === "Postman" ? "receipt for order 123: 2 x widget\n" : "order,qty\nA-1,2\n";
                    assert.deepEqual(upload.files.receipt, [receipt]);
                    assert.match(String(upload.headers["Content-Type"]?.[0]), /^multipart\/form-data; boundary=/);
                    const csv = echoOf(
                        ok(await h.call({ action: "run", request: `${prefix}Import orders`, ...where })),
                    );
                    assert.equal(csv.method, "PUT");
                    assert.equal(Buffer.from(csv.data.split(",")[1] ?? "", "base64").toString(), receipt);
                });
            }
        });

        describe("the engine, with ad-hoc calls", () => {
            const adHoc = (input: Record<string, unknown>) =>
                h.call({ ...input, path: input.path ?? "/anything", timeoutSec: input.timeoutSec ?? 20 });

            before(() => {
                h.reset();
                Object.assign(h.api, { origin: origin() });
                h.configure(h.section({ none: true }));
            });

            test("every method arrives as itself, with its JSON body untouched: numbers, escapes and non-ASCII text", async () => {
                const body = {
                    n: 9007199254740991,
                    big: 1.5e300,
                    text: 'a "quoted" \\ back\u00e9\u4e16\ud83d\ude00',
                    list: [1, null, true],
                };
                for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
                    const seen = echoOf(ok(await adHoc({ method, body })));
                    assert.equal(seen.method, method);
                    assert.equal((seen.json as typeof body).text, body.text);
                    assert.deepEqual((seen.json as typeof body).list, body.list);
                    assert.equal(JSON.parse(seen.data).n, 9007199254740991);
                }
                assert.equal(
                    echoOf(ok(await adHoc({ method: "GET", path: "/anything?a=1&a=2&b=%20x" }))).args.a?.join(","),
                    "1,2",
                );
            });

            test("a header the call gives reaches the server, and one the tool adds is the tool's", async () => {
                const seen = echoOf(
                    ok(await adHoc({ method: "GET", headers: { "X-Trace-Id": "trace-123", Accept: "text/plain" } })),
                );
                assert.deepEqual(seen.headers["X-Trace-Id"], ["trace-123"]);
                assert.deepEqual(seen.headers.Accept, ["text/plain"]);
                assert.deepEqual(seen.headers["User-Agent"], ["jig-api"]);
            });

            test("a redirect is not followed: the result says where it points, and the other host is never called", async () => {
                const text = ok(
                    await adHoc({
                        method: "GET",
                        path: "/redirect-to?url=http%3A%2F%2F127.0.0.1%3A9%2Felsewhere&status_code=302",
                    }),
                );
                assert.match(text, /^GET .* -> HTTP 302 Found/);
                assert.match(text, /not followed/i);
                assert.match(text, /127\.0\.0\.1:9\/elsewhere/);
            });

            test("a cookie the server sets is dropped from the answer and is never sent back", async () => {
                const set = ok(await adHoc({ method: "GET", path: "/cookies/set?session=abc" }));
                assert.ok(!/set-cookie/i.test(set), set);
                const cookies = ok(await adHoc({ method: "GET", path: "/cookies" }));
                assert.match(cookies, /"cookies": \{\}|"cookies":\{\}/);
            });

            test("a status that is not 2xx is a normal result, and a write that got a 5xx may still have happened", async () => {
                assert.match(ok(await adHoc({ method: "GET", path: "/status/404" })), /^GET .* -> HTTP 404 Not Found/);
                const failed = ok(await adHoc({ method: "POST", path: "/status/503", body: { a: 1 } }));
                assert.match(failed, /-> HTTP 503 Service Unavailable/);
                assert.match(failed, /may still have been carried out/i);
            });

            test("other kinds of body: text, HTML, an image and gzip", async () => {
                assert.match(ok(await adHoc({ method: "GET", path: "/html" })), /^GET .* -> HTTP 200 OK/);
                assert.match(ok(await adHoc({ method: "GET", path: "/image/png" })), /\(binary body, \d+ bytes\)/);
                assert.match(ok(await adHoc({ method: "GET", path: "/gzip" })), /"gzipped": true/);
            });

            test("a server that is slow is told after the time the call allowed", async () => {
                const result = await adHoc({ method: "GET", path: "/delay/3", timeoutSec: 1 });
                assert.match(result.error?.message ?? "", /timed out|no answer|time/i);
            });

            test("an answer over 2 MiB is cut there, and the result says so", { timeout: 60_000 }, async () => {
                // The request is small; httpbin makes the three million bytes of text.
                const text = ok(await adHoc({ method: "GET", path: "/range/3000000" }));
                assert.match(text, /\[the answer was cut at 2097152 bytes\]/);
                assert.ok(text.length <= 2 * 1024 * 1024 + 2000, "no more than the cap is returned");
                const binary = ok(await adHoc({ method: "GET", path: "/bytes/3000000" }));
                assert.match(binary, /^GET .* -> HTTP 200 OK/);
                assert.match(binary, /\(binary body, 2097152 bytes, cut\)/);
            });

            test("a request body over 256 KiB is refused before it is sent", async () => {
                const result = await adHoc({ method: "POST", body: { big: "x".repeat(300 * 1024) } });
                assert.match(result.blocked ?? result.error?.message ?? "", /body is larger than 256 KiB/);
            });
        });
    },
);
