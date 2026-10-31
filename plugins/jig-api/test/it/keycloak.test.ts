// jig-api's OAuth sign-in against a real Keycloak, through jig-core's own OAuth code: the client-credentials grant for a service and
// the password grant for a person, from a realm imported from a fixture file. The token is used where Keycloak can check it, at its
// own user-info endpoint, which answers for whom the token was issued. Tokens are throwaway values of the realm's fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { describeIt, must } from "../../../../test/support/it.ts";
import { ok, setupHarness } from "../support/harness.ts";
import type { Harness } from "../support/harness.ts";

const realm = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "keycloak", "realm.json"), "utf8"),
);
const client = (id: string) =>
    realm.clients.find((entry: { clientId: string }) => entry.clientId === id) as { clientId: string; secret: string };
const SERVICE = client("jig-service");
const PORTAL = client("jig-portal");
const PERSON = realm.users[0] as { username: string; credentials: Array<{ value: string }> };

const REFERENCES = {
    serviceSecret: "env:KC_SERVICE_SECRET",
    portalSecret: "env:KC_PORTAL_SECRET",
    user: "env:KC_USER",
    password: "env:KC_PASSWORD",
};

describeIt(
    "jig-api OAuth against Keycloak",
    {
        service: "keycloak",
        variables: ["JIG_IT_KEYCLOAK_URL"],
        hint: "Keycloak in dev mode with test/it/keycloak/realm.json imported (set JIG_IT_KEYCLOAK_URL=http://127.0.0.1:8180)",
    },
    () => {
        let h: Harness;
        const origin = () => must("JIG_IT_KEYCLOAK_URL").replace(/\/$/, "");
        /** Every request that left for the token endpoint, as the network saw it. */
        const tokenRequests: Array<{ body: string; authorization: string | null }> = [];

        /** A Postman collection with one request, the user-info endpoint, signed in with OAuth as asked. */
        function use(oauth: Array<{ key: string; value: string }>, secrets: Record<string, string>): void {
            h.reset();
            tokenRequests.length = 0;
            const base = origin();
            const collection = {
                info: { name: "Realm", schema: "https://schema.postman.com/json/collection/v2.1.0/collection.json" },
                auth: { type: "oauth2", oauth2: oauth },
                item: [
                    {
                        name: "Who am I",
                        request: {
                            method: "GET",
                            url: { raw: "{{baseUrl}}/realms/jigit/protocol/openid-connect/userinfo" },
                        },
                    },
                ],
            };
            const values = [
                { key: "baseUrl", value: base, type: "default", enabled: true },
                ...Object.keys(secrets).map((key) => ({ key, value: "", type: "secret", enabled: true })),
            ];
            fs.writeFileSync(path.join(h.dir, "realm.postman_collection.json"), JSON.stringify(collection));
            fs.writeFileSync(
                path.join(h.dir, "realm-staging.postman_environment.json"),
                JSON.stringify({ name: "Staging", values }),
            );
            h.configure({
                collections: {
                    realm: {
                        postman: path.join(h.dir, "realm.postman_collection.json"),
                        environments: { Staging: path.join(h.dir, "realm-staging.postman_environment.json") },
                    },
                },
                environments: { Staging: "staging" },
                secrets: Object.fromEntries(Object.entries(secrets).map(([name, reference]) => [name, reference])),
                allowPlainLocal: true,
            });
            h.jig.secrets.set(REFERENCES.serviceSecret, SERVICE.secret);
            h.jig.secrets.set(REFERENCES.portalSecret, PORTAL.secret);
            h.jig.secrets.set(REFERENCES.user, PERSON.username);
            h.jig.secrets.set(REFERENCES.password, PERSON.credentials[0]?.value ?? "");
            // The network is the real one; it is only watched, to count the requests to the token endpoint.
            h.jig.setFetch(async (input, init) => {
                if (String(input).includes("/protocol/openid-connect/token")) {
                    tokenRequests.push({
                        body: String(init?.body ?? ""),
                        authorization: new Headers(init?.headers).get("authorization"),
                    });
                }
                return fetch(input, init);
            });
            h.jig.setNow(Date.now);
            h.clock.now = Date.now();
        }

        const tokenUrl = `{{baseUrl}}/realms/jigit/protocol/openid-connect/token`;
        const clientCredentials = (secret = "clientSecret") => ({
            oauth: [
                { key: "grant_type", value: "client_credentials" },
                { key: "accessTokenUrl", value: tokenUrl },
                { key: "clientId", value: SERVICE.clientId },
                { key: "clientSecret", value: `{{${secret}}}` },
                // The user-info endpoint answers only for a token that was asked for with this scope.
                { key: "scope", value: "openid" },
            ],
            secrets: { [secret]: REFERENCES.serviceSecret },
        });
        const password = (secret: string, pass: string) => ({
            oauth: [
                { key: "grant_type", value: "password_credentials" },
                { key: "accessTokenUrl", value: tokenUrl },
                { key: "clientId", value: PORTAL.clientId },
                { key: "clientSecret", value: "{{clientSecret}}" },
                { key: "username", value: "{{username}}" },
                { key: "password", value: "{{password}}" },
                { key: "scope", value: "openid" },
            ],
            secrets: { clientSecret: secret, username: REFERENCES.user, password: pass },
        });
        const whoAmI = () =>
            h.call({ action: "run", request: "Who am I", collection: "realm", environment: "Staging" });

        before(async () => {
            h = await setupHarness();
            const info = (await fetch(`${origin()}/realms/jigit`).then((reply) => reply.json())) as { realm: string };
            console.log(`Keycloak realm ${info.realm} at ${origin()}`);
        });
        after(() => h.close());

        test("client credentials: the service gets a token from the real realm and Keycloak says whose it is", async () => {
            const setup = clientCredentials();
            use(setup.oauth, setup.secrets);
            const text = ok(await whoAmI());
            assert.match(text, /-> HTTP 200 OK/);
            const body = JSON.parse(text.slice(text.indexOf("\n\n") + 2));
            assert.equal(body.preferred_username, `service-account-${SERVICE.clientId}`);
            assert.equal(tokenRequests.length, 1);
            assert.match(tokenRequests[0]?.body ?? "", /grant_type=client_credentials/);
            assert.ok(!text.includes(SERVICE.secret), "the client secret is not in the result");
        });

        test("the token is kept until it expires, and a new one is asked for after that", async () => {
            const setup = clientCredentials();
            use(setup.oauth, setup.secrets);
            ok(await whoAmI());
            ok(await whoAmI());
            assert.equal(tokenRequests.length, 1, "the second call used the token it already had");
            // Keycloak's tokens last 300 seconds (the realm says so); the token cache reads the clock the plugin reads.
            h.clock.now += 400_000;
            h.jig.setNow(() => h.clock.now);
            ok(await whoAmI());
            assert.equal(tokenRequests.length, 2, "an expired token is replaced");
        });

        test("password grant: a person's token comes from the realm, and Keycloak says who it is", async () => {
            const setup = password(REFERENCES.portalSecret, REFERENCES.password);
            use(setup.oauth, setup.secrets);
            const text = ok(await whoAmI());
            assert.match(text, /-> HTTP 200 OK/);
            const body = JSON.parse(text.slice(text.indexOf("\n\n") + 2));
            assert.equal(body.preferred_username, PERSON.username);
            assert.equal(body.email, "jigit-user@example.test");
            assert.match(tokenRequests[0]?.body ?? "", /grant_type=password/);
            assert.ok(!text.includes(PERSON.credentials[0]?.value ?? "?"), "the password is not in the result");
        });

        test("a wrong client secret is Keycloak's refusal, told without repeating a secret", async () => {
            const setup = clientCredentials("clientSecret");
            use(setup.oauth, { clientSecret: "env:KC_WRONG" });
            h.jig.secrets.set("env:KC_WRONG", "not-the-clients-secret");
            const result = await whoAmI();
            const said = result.error?.message ?? "";
            assert.match(said, /token|sign-in|401|unauthorized/i, said);
            assert.ok(!said.includes("not-the-clients-secret"));
            assert.ok(!said.includes(SERVICE.secret));
        });

        test("a wrong password is refused too, and no request goes to the API with a token that was not given", async () => {
            const setup = password(REFERENCES.portalSecret, "env:KC_WRONG_PASSWORD");
            use(setup.oauth, setup.secrets);
            h.jig.secrets.set("env:KC_WRONG_PASSWORD", "not-the-password");
            const result = await whoAmI();
            const said = result.error?.message ?? "";
            assert.match(said, /token|sign-in|401|unauthorized|invalid/i, said);
            assert.ok(!said.includes("not-the-password"));
            assert.equal(tokenRequests.length, 1, "one try, no retry");
        });

        test("the token endpoint is checked against the environment's hosts before a secret is sent to it", async () => {
            const setup = clientCredentials();
            use(
                setup.oauth.map((entry) =>
                    entry.key === "accessTokenUrl"
                        ? {
                              key: "accessTokenUrl",
                              value: "http://127.0.0.1:9/realms/jigit/protocol/openid-connect/token",
                          }
                        : entry,
                ),
                setup.secrets,
            );
            const result = await whoAmI();
            assert.match(result.blocked ?? result.error?.message ?? "", /host|environment/i);
            assert.equal(tokenRequests.length, 0);
        });
    },
);
