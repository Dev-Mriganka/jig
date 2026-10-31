// jig-logs against Grafana Loki 3, a single node that has tenants switched on (so the tenant header is proven), and a
// second node with tight limits (so the errors Loki words for them are proven). Loki speaks plain HTTP and has no sign-in
// of its own, so requests travel through a transport, as they do behind a company's gateway.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { describeIt, must } from "../../../../test/support/it.ts";
import { baseTime, dataset, HOUR, MINUTE, runName } from "../support/dataset.ts";
import { plainTransport, realWorld } from "../support/real.ts";
import { seedLoki } from "../support/seed.ts";
import type { Line } from "../support/dataset.ts";
import { commonTests, hitLines, textOf } from "./suite.ts";
import type { Flavor, WorldOptions } from "./suite.ts";

const TENANT = "jig-it";

/** Text with characters that mean something in a regular expression, in a quoted string, or in a line. */
const SPECIAL = [
    'path C:\\temp\\new "quoted" and [x] (y)',
    "a.b*c+d? | pipe $dollar ^caret {brace}",
    "unicode café ✓ naïve",
    "ends with a backslash \\",
];

describeIt(
    "jig-logs against Grafana Loki 3",
    {
        service: "loki",
        variables: ["JIG_IT_LOKI_URL", "JIG_IT_LOKI_LIMITED_URL"],
        hint: "two Grafana Loki 3 nodes with -auth.enabled=true",
    },
    () => {
        const run = runName();
        const base = baseTime();
        const url = () => must("JIG_IT_LOKI_URL");
        const limitedUrl = () => must("JIG_IT_LOKI_LIMITED_URL");
        const hour = { from: new Date(base).toISOString(), to: new Date(base + HOUR).toISOString() };

        /** The `logs` section for a node. `tenant: undefined` leaves the header out. */
        function section(address: string, options: WorldOptions & { tenant?: string | undefined } = {}) {
            const tenant = "tenant" in options ? options.tenant : TENANT;
            return {
                backend: {
                    type: "loki",
                    url: address,
                    transport: "plain",
                    ...(tenant === undefined ? {} : { tenant }),
                    ...options.backend,
                },
                environments: {
                    staging: { selector: `{run="${run}", env="staging"}` },
                    listed: {
                        selector: `{run="${run}", env="staging"}`,
                        filter: { service: ["orders-api", "billing-api"] },
                    },
                    prod: { selector: `{run="${run}", env="prod"}`, jigEnvironment: "production" },
                    ...options.environments,
                },
            };
        }

        const flavor: Flavor = {
            name: "Loki",
            base,
            exactCounts: false,
            // The first two `payment timeout` lines: a regular expression on the line.
            twoAttemptsQuery: '|= "timeout" |~ "attempt [12] of"',
            anyOfQuery: '|~ "created|accepted"',
            // A regular expression that is never closed: the check on the query passes it and Loki rejects it.
            malformedQuery: '|~ "("',
            world(t, options = {}) {
                const w = realWorld(t, {
                    section: section(url(), options),
                    ...(options.now === undefined ? {} : { now: options.now }),
                });
                w.jig.transports.set("plain", plainTransport);
                return w;
            },
        };

        before(async () => {
            const lines = dataset(base);
            await seedLoki({ url: url(), headers: { "X-Scope-OrgID": TENANT } }, run, lines);
            await seedLoki({ url: limitedUrl(), headers: { "X-Scope-OrgID": TENANT } }, run, lines);
            // Lines whose text a regular expression or a quoted string would mistake for syntax.
            const special: Line[] = SPECIAL.map((message, n) => ({
                at: base + 40 * MINUTE + n * 1000,
                env: "special" as Line["env"],
                service: "orders-api",
                message,
            }));
            await seedLoki({ url: url(), headers: { "X-Scope-OrgID": TENANT } }, run, special);
            const version = await fetch(`${url()}/loki/api/v1/status/buildinfo`, {
                headers: { "X-Scope-OrgID": TENANT },
            });
            console.log(`Loki ${JSON.stringify(await version.json())}`);
        });

        commonTests(flavor);

        test("a selector that matches no stream finds nothing, and the check for data says the environment is empty", async (t) => {
            const w = flavor.world(t, {
                environments: { nowhere: { selector: `{run="${run}-none", env="staging"}` } },
            });
            const text = textOf(await w.call({ phrase: "x", environment: "nowhere", ...hour }));
            assert.match(text, /complete, 0 hits,/);
            assert.match(text, /Availability: no documents at all in this environment and window\./);
        });

        test("a phrase is matched as text: quotes, backslashes, brackets and regular expression characters mean nothing", async (t) => {
            const w = flavor.world(t, { environments: { special: { selector: `{run="${run}", env="special"}` } } });
            const window = { from: new Date(base).toISOString(), to: new Date(base + HOUR).toISOString() };
            for (const [phrase, found] of [
                ['C:\\temp\\new "quoted" and [x] (y)', SPECIAL[0]],
                ["a.b*c+d? | pipe $dollar ^caret {brace}", SPECIAL[1]],
                ["CAFÉ ✓ NAÏVE", SPECIAL[2]],
                ["a backslash \\", SPECIAL[3]],
            ] as const) {
                const text = textOf(await w.call({ phrase, environment: "special", ...window }));
                assert.match(text, /complete, 1 hit,/, phrase);
                assert.equal(hitLines(text)[0]?.slice(25), found);
            }
            // `.` is a dot and `*` a star: the same text with other characters is not a match.
            const none = textOf(await w.call({ phrase: "a_b*c+d?", environment: "special", ...window }));
            assert.match(none, /complete, 0 hits,/);
            const regular = textOf(await w.call({ phrase: ".*", environment: "special", ...window }));
            assert.match(regular, /complete, 0 hits,/);
        });

        test("a label filter of one value is an equality matcher, and of a list a regular expression that matches the whole value", async (t) => {
            const w = flavor.world(t, {
                environments: {
                    one: { selector: `{run="${run}"}`, filter: { service: "billing-api", env: "staging" } },
                    // `orders` must not match `orders-api`: the matcher is anchored.
                    anchored: { selector: `{run="${run}"}`, filter: { service: ["orders", "billing"] } },
                },
            });
            const one = textOf(await w.call({ phrase: "invoice", environment: "one", ...hour }));
            assert.match(one, /complete, 5 hits,/);
            const anchored = textOf(await w.call({ phrase: "invoice", environment: "anchored", ...hour }));
            assert.match(anchored, /complete, 0 hits,/);
        });

        test("the tenant header is sent: without it Loki answers 401 and the message names backend.tenant", async (t) => {
            const w = realWorld(t, { section: section(url(), { tenant: undefined }) });
            w.jig.transports.set("plain", plainTransport);
            const result = await w.call({ phrase: "req-7f3a9c", environment: "staging", ...hour });
            assert.match(
                result.error?.message ?? result.text,
                /^The backend did not accept the sign-in \(HTTP 401\): sign in again, or check backend\.auth and backend\.tenant in the logs section of jig\.json$/,
            );
        });

        test("a query that could leave the stream selector is refused before anything is sent", async (t) => {
            const w = flavor.world(t);
            const result = await w.call({ query: '|= "x" } or {env="prod"', environment: "staging", ...hour });
            assert.ok(result.classifyError instanceof TypeError);
            assert.match(result.classifyError.message, /^logs: a Loki query cannot hold \{ outside quotes/);
            assert.equal(result.error?.message, result.classifyError.message);
        });

        test("a line filter in LogQL, and a JSON pipeline, run on the real parser", async (t) => {
            const w = flavor.world(t);
            const pipeline = textOf(
                await w.call({
                    query: '|= "order batch" | line_format "{{.service}} batch"',
                    environment: "staging",
                    ...hour,
                }),
            );
            assert.match(hitLines(pipeline)[0] ?? "", /orders-api batch$/);
        });

        test("a window longer than the node allows is halved until it fits, and every half is searched", async (t) => {
            // The node allows 20 minutes; this window is 40, and it is halved until Loki accepts the pieces.
            const w = realWorld(t, { section: section(limitedUrl()), now: base + 40 * MINUTE });
            w.jig.transports.set("plain", plainTransport);
            const text = textOf(
                await w.call({ phrase: "order accepted", environment: "staging", size: 100, window: "40m" }),
            );
            assert.match(
                text,
                /complete, (at least )?40 hits, 40 fetched \(oldest first\), 20 shown, \d+ buckets \(\d+ split after a timeout\)/,
            );
            assert.equal((w.jig.facts.get("call-1") ?? [])[0]?.status, "complete");
            assert.ok(((w.jig.facts.get("call-1") ?? [])[0]?.requests as number) > 2, "the window was split");
        });

        test("a window that cannot be halved small enough is a gap named window_too_long, with what to do", async (t) => {
            // Six hours is one bucket, and four halvings leave 22 minutes, over the 20 the node allows.
            const w = realWorld(t, { section: section(limitedUrl()), now: base + 6 * HOUR });
            w.jig.transports.set("plain", plainTransport);
            const text = textOf(await w.call({ phrase: "order accepted", environment: "staging", window: "6h" }));
            assert.match(text, /failed|partial/);
            assert.match(text, /Gaps: .*window_too_long/);
            assert.match(
                text,
                /Next: The backend does not search a window this long in one request; use a shorter window\./,
            );
        });

        test("asking for more lines than the node returns is said so, once, and stops the search", async (t) => {
            const w = realWorld(t, { section: section(limitedUrl()) });
            w.jig.transports.set("plain", plainTransport);
            const text = textOf(await w.call({ phrase: "order accepted", environment: "staging", size: 200, ...hour }));
            assert.match(text, /failed, no window could be searched/);
            assert.match(text, /response_too_large/);
            assert.match(text, /Next: Lower size or narrow the window\./);
            assert.equal(
                (w.jig.facts.get("call-1") ?? [])[0]?.requests,
                1,
                "the search stopped after the first answer",
            );
        });
    },
);
