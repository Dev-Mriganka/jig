// jig-logs against Elasticsearch (8 or 9) with security on: the node is reached over HTTPS with a certificate authority of its own
// (the run sets NODE_EXTRA_CA_CERTS) and the tool signs in with a basic-auth user. The user is made for the run, with a role
// that reads only this run's indexes, and a second user shows what a denied sign-in looks like.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { describeIt, must } from "../../../../test/support/it.ts";
import { baseTime, dataset, HOUR, runName } from "../support/dataset.ts";
import { realWorld } from "../support/real.ts";
import { dropIndex, seedIndex, send } from "../support/seed.ts";
import type { Connection } from "../support/seed.ts";
import { commonTests, elasticTests, textOf, throwawayPassword } from "./suite.ts";
import type { Flavor } from "./suite.ts";

describeIt(
    "jig-logs against Elasticsearch",
    {
        service: "elasticsearch",
        variables: ["JIG_IT_ELASTICSEARCH_URL", "JIG_IT_ELASTICSEARCH_PASSWORD"],
        hint: "a single-node Elasticsearch 8 or 9 with security on, and its elastic password",
    },
    () => {
        const run = runName();
        const base = baseTime();
        const index = `jig-it-${run}`;
        const altIndex = `${index}-alt`;
        const url = () => must("JIG_IT_ELASTICSEARCH_URL");
        const reader = { user: `jig-it-${run}`, password: throwawayPassword() };
        const denied = { user: `jig-it-${run}-denied`, password: throwawayPassword() };
        const hour = { from: new Date(base).toISOString(), to: new Date(base + HOUR).toISOString() };

        const admin = (): Connection => ({
            url: url(),
            headers: {
                authorization: `Basic ${Buffer.from(`elastic:${must("JIG_IT_ELASTICSEARCH_PASSWORD")}`).toString("base64")}`,
            },
        });

        /** The `logs` section signing in as `who`, with `password` held under a reference like jig.json's. */
        const section = (
            who: { user: string } = reader,
            environments: Record<string, unknown> = {},
            backend: Record<string, unknown> = {},
        ) => ({
            backend: { url: url(), auth: { username: who.user, password: "env:JIG_IT_ES_PASSWORD" }, ...backend },
            environments: {
                staging: { index, filter: { env: "staging" } },
                listed: { index, filter: { env: "staging", service: ["orders-api", "billing-api"] } },
                prod: { index, filter: { env: "prod" }, jigEnvironment: "production" },
                ...environments,
            },
        });

        const flavor: Flavor = {
            name: "Elasticsearch",
            base,
            exactCounts: true,
            twoAttemptsQuery: 'message:"payment timeout" AND message:(attempt AND (1 OR 2))',
            anyOfQuery: "message:(created OR accepted)",
            // An unclosed group is a syntax error in the query string.
            malformedQuery: "message:(unclosed",
            world(t, options = {}) {
                return realWorld(t, {
                    section: section(reader, options.environments, options.backend),
                    secrets: { "env:JIG_IT_ES_PASSWORD": reader.password },
                    ...(options.now === undefined ? {} : { now: options.now }),
                });
            },
        };

        before(async () => {
            if (url().startsWith("https:") && (process.env.NODE_EXTRA_CA_CERTS ?? "") === "") {
                throw new Error(
                    "NODE_EXTRA_CA_CERTS must name the node's certificate authority (config/certs/http_ca.crt)",
                );
            }
            const info = JSON.parse(await send(admin(), "GET", "/"));
            console.log(`Elasticsearch ${info.version.number} (Lucene ${info.version.lucene_version})`);

            const lines = dataset(base);
            await seedIndex(admin(), index, lines);
            await seedIndex(admin(), altIndex, lines, { time: "ts", message: "msg", epoch: true });
            await send(admin(), "PUT", `/_security/role/${reader.user}`, {
                indices: [{ names: [`${index}*`], privileges: ["read"] }],
            });
            await send(admin(), "PUT", `/_security/user/${reader.user}`, {
                password: reader.password,
                roles: [reader.user],
            });
            await send(admin(), "PUT", `/_security/role/${denied.user}`, {
                indices: [{ names: [`other-${run}*`], privileges: ["read"] }],
            });
            await send(admin(), "PUT", `/_security/user/${denied.user}`, {
                password: denied.password,
                roles: [denied.user],
            });
        });

        after(async () => {
            for (const user of [reader.user, denied.user]) {
                await send(admin(), "DELETE", `/_security/user/${user}`);
                await send(admin(), "DELETE", `/_security/role/${user}`);
            }
            await dropIndex(admin(), index);
            await dropIndex(admin(), altIndex);
        });

        commonTests(flavor);
        elasticTests(flavor, { index: altIndex });

        test("a wrong password is the sign-in message, and the password is not repeated", async (t) => {
            const w = realWorld(t, {
                section: section(reader),
                secrets: { "env:JIG_IT_ES_PASSWORD": `${reader.password}-wrong` },
            });
            const result = await w.call({ phrase: "req-7f3a9c", environment: "staging", ...hour });
            const message = result.error?.message ?? "";
            assert.equal(
                message,
                "The backend did not accept the sign-in (HTTP 401): sign in again, or check backend.auth in the logs section of jig.json",
            );
            for (const secret of w.jig.issued) assert.ok(!message.includes(secret));
        });

        test("a user that may not read the index is told so, and that signing in again will not help", async (t) => {
            const w = realWorld(t, {
                section: section(denied),
                secrets: { "env:JIG_IT_ES_PASSWORD": denied.password },
            });
            const result = await w.call({ phrase: "req-7f3a9c", environment: "staging", ...hour });
            assert.equal(
                result.error?.message,
                "The backend denied this sign-in access to the index (HTTP 403): signing in again will not help, so ask for access to it",
            );
        });

        test("a user that does not exist is also the sign-in message", async (t) => {
            const w = realWorld(t, {
                section: section({ user: `nobody-${run}` }),
                secrets: { "env:JIG_IT_ES_PASSWORD": reader.password },
            });
            const result = await w.call({ phrase: "x", environment: "staging", ...hour });
            assert.match(result.error?.message ?? "", /^The backend did not accept the sign-in \(HTTP 401\)/);
        });

        test("an API key, in the form Elasticsearch gives it, signs in", async (t) => {
            const made = JSON.parse(
                await send(admin(), "POST", "/_security/api_key", {
                    name: `jig-it-${run}`,
                    role_descriptors: { reader: { indices: [{ names: [`${index}*`], privileges: ["read"] }] } },
                }),
            );
            t.after(() => send(admin(), "DELETE", "/_security/api_key", { ids: [made.id] }).then(() => undefined));
            const w = realWorld(t, {
                section: {
                    backend: { url: url(), auth: { apiKey: "env:JIG_IT_ES_KEY" } },
                    environments: section().environments,
                },
                secrets: { "env:JIG_IT_ES_KEY": made.encoded },
            });
            const text = textOf(await w.call({ phrase: "req-7f3a9c", environment: "staging", ...hour }));
            assert.match(text, /complete, 3 hits,/);
            const wrong = realWorld(t, {
                section: {
                    backend: { url: url(), auth: { apiKey: "env:JIG_IT_ES_KEY" } },
                    environments: section().environments,
                },
                secrets: { "env:JIG_IT_ES_KEY": Buffer.from(`${made.id}:not-the-key`).toString("base64") },
            });
            const refused = await wrong.call({ phrase: "req-7f3a9c", environment: "staging", ...hour });
            assert.match(refused.error?.message ?? "", /^The backend did not accept the sign-in \(HTTP 401\)/);
        });

        test("a sign-in service gives the headers, for every request, and the tool never sees the password", async (t) => {
            const w = realWorld(t, {
                section: {
                    backend: { url: url(), auth: { signIn: "corp-sso" } },
                    environments: section().environments,
                },
            });
            const header = `Basic ${Buffer.from(`${reader.user}:${reader.password}`).toString("base64")}`;
            w.jig.signInServices.set("corp-sso", { headers: async () => ({ authorization: header }) });
            const text = textOf(await w.call({ phrase: "req-7f3a9c", environment: "staging", ...hour }));
            assert.match(text, /complete, 3 hits,/);
            assert.equal(w.jig.signedIn.length, 1);
            assert.equal(w.jig.signedIn[0]?.system, "logs");
            assert.match(
                w.jig.signedIn[0]?.url ?? "",
                new RegExp(`^${url().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${index}/_search$`),
            );
            assert.equal(w.jig.signedIn[0]?.method, "POST");
        });

        test("the search is sent over TLS, signed in with Basic, and the node answers the request it was sent", async (t) => {
            const w = flavor.world(t);
            textOf(await w.call({ phrase: "req-7f3a9c", environment: "staging", ...hour }));
            assert.deepEqual(w.jig.resolved, ["env:JIG_IT_ES_PASSWORD"], "the secret was read once for the call");
            const text = textOf(await w.call({ phrase: "req-7f3a9c", environment: "staging", ...hour }));
            assert.match(text, /complete, 3 hits,/);
            assert.deepEqual(
                w.jig.resolved,
                ["env:JIG_IT_ES_PASSWORD", "env:JIG_IT_ES_PASSWORD"],
                "and again for the next call",
            );
        });
    },
);
