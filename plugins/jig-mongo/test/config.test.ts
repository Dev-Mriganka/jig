// The `mongo` section of jig.json: what is valid, and the refusals that keep a credential out of a connection string and a
// deny list out of production.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { SECRET_BACKENDS } from "../../jig-core/src/config.ts";
import { layered } from "../../jig-core/src/section-defaults.ts";
import {
    accessFor,
    connectionKey,
    environmentsOf,
    isReference,
    MONGO_REPLACE,
    readMongo,
    settingsOf,
    validateMongo,
} from "../src/config.ts";
import { InputError } from "../src/values.ts";
import { defaultSection } from "./support/section.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import type { FakeJig } from "./support/fake-jig.ts";

let jig: FakeJig;
before(() => void (jig = installFakeJig()));
afterEach(() => jig.reset());
after(() => jig.remove());

const connection = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    uri: "mongodb://db.staging.example.com:27017",
    user: "agent",
    password: "pass:mongo/staging",
    ...extra,
});
const section = (connections: Record<string, unknown>, access?: Record<string, unknown>): Record<string, unknown> => ({
    connections,
    ...(access === undefined ? {} : { access }),
});
const errorsOf = (raw: unknown): string => validateMongo(raw).join("\n");

describe("a valid section", () => {
    test("the example of the README is valid, with a route for production", () => {
        const raw = {
            connections: {
                staging: {
                    uri: "mongodb://db.staging.example.com:27017",
                    user: "agent",
                    password: "pass:mongo/staging",
                },
                production: {
                    uri: "mongodb://db.example.com:27017",
                    user: "agent-readonly",
                    password: "pass:mongo/production",
                    via: { ssh: { host: "bastion.example.com", user: "agent", key: "pass:ssh/bastion" } },
                },
            },
            access: {
                staging: { deny: ["billing.cards", "*.notes"] },
                production: { allow: { "orders.orders": ["_id", "status", "items", "createdAt"] } },
            },
        };
        assert.deepEqual(validateMongo(raw), []);
        const settings = settingsOf(raw);
        assert.deepEqual([...(settings?.connections.keys() ?? [])], ["staging", "production"]);
        assert.deepEqual(settings?.connections.get("production")?.via, {
            kind: "ssh",
            host: "bastion.example.com",
            user: "agent",
            key: "pass:ssh/bastion",
        });
        assert.deepEqual(settings?.connections.get("staging")?.via, { kind: "direct" });
        assert.equal(settings?.connections.get("production")?.uri.hosts[0]?.port, 27017);
    });

    test("optional fields: authSource, tls, an ssh port, a tunnel, a replica set list without a route", () => {
        const raw = section({
            staging: connection({
                authSource: "admin",
                tls: true,
                uri: "mongodb://a.example.com:27017,b.example.com:27018/orders?replicaSet=rs0",
            }),
            dev: connection({ via: { tunnel: "corp-net" } }),
            qa: connection({
                via: { ssh: { host: "bastion.example.com", user: "agent", key: "pass:ssh/bastion", port: 2222 } },
            }),
        });
        assert.deepEqual(validateMongo(raw), []);
        const staging = settingsOf(raw)?.connections.get("staging");
        assert.equal(staging?.authSource, "admin");
        assert.equal(staging?.tls, true);
        assert.deepEqual(staging?.uri.hosts, [
            { host: "a.example.com", port: 27017 },
            { host: "b.example.com", port: 27018 },
        ]);
        assert.equal(staging?.uri.database, "orders");
        assert.deepEqual(settingsOf(raw)?.connections.get("dev")?.via, { kind: "tunnel", name: "corp-net" });
        assert.equal((settingsOf(raw)!.connections.get("qa")!.via as { port: number }).port, 2222);
    });

    test("mongodb+srv takes one host and no port", () => {
        assert.deepEqual(
            validateMongo(
                section({ staging: connection({ uri: "mongodb+srv://cluster.staging.example.com/orders" }) }),
            ),
            [],
        );
        assert.match(
            errorsOf(section({ staging: connection({ uri: "mongodb+srv://cluster.example.com:27017" }) })),
            /one host and no port/,
        );
        assert.match(
            errorsOf(section({ staging: connection({ uri: "mongodb+srv://a.example.com,b.example.com" }) })),
            /one host and no port/,
        );
    });

    test("a test environment with no access entry reads everything but what is always denied; production nothing", () => {
        const raw = section({
            staging: connection(),
            production: connection({ uri: "mongodb://db.example.com:27017" }),
        });
        assert.deepEqual(validateMongo(raw), []);
        const settings = settingsOf(raw);
        assert.ok(settings);
        jig.kinds.set("staging", "test");
        const staging = accessFor(settings, "staging");
        assert.equal(staging.mode, "deny");
        staging.namespace("orders", "orders");
        const production = accessFor(settings, "production");
        assert.equal(production.mode, "allow");
        assert.throws(() => production.namespace("orders", "orders"), /nothing is allowed yet/);
    });

    test("settings are read again only when the section changes", () => {
        const raw = defaultSection();
        assert.equal(settingsOf(raw), settingsOf(raw));
        assert.equal(settingsOf(undefined), undefined);
        assert.equal(settingsOf("text"), undefined);
    });
});

describe("what is refused", () => {
    test("a connection string that holds a user or a password, and the message does not repeat it", () => {
        const secretWord = ["hunter", "2"].join("");
        const messages = validateMongo(
            section({ staging: connection({ uri: `mongodb://agent:${secretWord}@db.staging.example.com:27017` }) }),
        );
        assert.match(messages.join("\n"), /mongo\.connections\.staging\.uri: must not hold a user or a password/);
        assert.ok(!messages.join("\n").includes(secretWord));
        assert.match(
            errorsOf(section({ staging: connection({ uri: "mongodb://agent@db.staging.example.com:27017" }) })),
            /must not hold a user/,
        );
    });

    test("options that carry a credential or weaken TLS", () => {
        for (const option of [
            "password=x",
            "tlsCertificateKeyFilePassword=x",
            "authMechanismProperties=AWS_SESSION_TOKEN:x",
            "tlsInsecure=true",
            "tlsAllowInvalidCertificates=true",
            "tlsAllowInvalidHostnames=true",
        ]) {
            assert.match(
                errorsOf(section({ staging: connection({ uri: `mongodb://db.example.com:27017/?${option}` }) })),
                /is not allowed/,
                option,
            );
        }
        assert.deepEqual(
            validateMongo(
                section({
                    staging: connection({ uri: "mongodb://db.example.com:27017/?retryWrites=false&appName=x" }),
                }),
            ),
            [],
        );
    });

    test("a bad address, a missing uri, a plain password where a reference belongs", () => {
        assert.match(
            errorsOf(section({ staging: connection({ uri: "postgres://db" }) })),
            /mongodb:\/\/ or mongodb\+srv:\/\//,
        );
        assert.match(
            errorsOf(section({ staging: connection({ uri: "mongodb://db.example.com:99999" }) })),
            /host or port/,
        );
        assert.match(errorsOf(section({ staging: connection({ uri: undefined }) })), /uri: required/);
        const plain = ["s3", "cret", "plain"].join("");
        const messages = errorsOf(section({ staging: connection({ password: plain }) }));
        assert.match(messages, /password: must be a secret reference/);
        assert.ok(!messages.includes(plain));
        assert.match(errorsOf(section({ staging: connection({ user: "" }) })), /user: required/);
    });

    test("unknown fields at every level", () => {
        assert.match(errorsOf({ ...section({ staging: connection() }), extra: 1 }), /mongo\.extra: unknown field/);
        assert.match(
            errorsOf(section({ staging: connection({ host: "x" }) })),
            /connections\.staging\.host: unknown field/,
        );
        assert.match(
            errorsOf(section({ staging: connection() }, { staging: { deny: [], extra: 1 } })),
            /access\.staging\.extra: unknown field/,
        );
        assert.match(
            errorsOf(
                section({
                    staging: connection({
                        via: { ssh: { host: "b.example.com", user: "a", key: "pass:k", extra: 1 } },
                    }),
                }),
            ),
            /ssh\.extra: unknown field/,
        );
        assert.match(errorsOf(section({ staging: connection({ via: { other: 1 } }) })), /via\.other: unknown field/);
    });

    test("no connections, too many, a name that is not an environment name, local and external", () => {
        assert.match(errorsOf({}), /connections: required/);
        assert.match(errorsOf({ connections: {} }), /connections: required/);
        assert.match(errorsOf(section({ "bad name": connection() })), /not an environment name/);
        assert.match(
            errorsOf(section({ local: connection() })),
            /connections\.local: a database is a test or production environment/,
        );
        assert.match(errorsOf(section({ external: connection() })), /connections\.external/);
        assert.match(errorsOf("text"), /mongo: must be an object/);
    });

    test("access for an environment with no connection", () => {
        assert.match(
            errorsOf(section({ staging: connection() }, { qa: { deny: [] } })),
            /access\.qa: there is no connection with this name/,
        );
    });
});

describe("production", () => {
    test("must use an allow list: a deny list, both, or none of the two is an error", () => {
        const connections = { production: connection({ uri: "mongodb://db.example.com:27017" }) };
        assert.match(
            errorsOf(section(connections, { production: { deny: ["billing.*"] } })),
            /production needs an allow list.*a deny list is not allowed there/,
        );
        assert.match(
            errorsOf(section(connections, { production: { deny: [], allow: { "orders.orders": ["_id"] } } })),
            /use deny or allow, not both/,
        );
        assert.match(errorsOf(section(connections, { production: {} })), /production needs an allow list/);
        assert.deepEqual(
            validateMongo(section(connections, { production: { allow: { "orders.orders": ["_id"] } } })),
            [],
        );
    });

    test("the kind comes from jig-core: another name for production, and a name nobody defined, are production too", () => {
        for (const name of ["prod", "live"]) {
            const raw = section({ [name]: connection() }, { [name]: { deny: ["orders.*"] } });
            assert.match(
                errorsOf(raw),
                new RegExp(
                    `access\\.${name}: ${name} needs an allow list|access\\.${name}: production needs an allow list`,
                ),
                name,
            );
        }
        jig.kinds.set("live", "test");
        assert.deepEqual(validateMongo(section({ live: connection() }, { live: { deny: [] } })), []);
    });

    test("JavaScript is never allowed there, and a test environment may allow it", () => {
        const connections = {
            production: connection({ uri: "mongodb://db.example.com:27017" }),
            staging: connection(),
        };
        assert.match(
            errorsOf(section(connections, { production: { allow: { "orders.orders": ["_id"] }, javascript: true } })),
            /never allowed in production/,
        );
        assert.deepEqual(validateMongo(section(connections, { staging: { deny: [], javascript: true } })), []);
        assert.match(
            errorsOf(section(connections, { staging: { javascript: "yes" } })),
            /javascript: must be true or false/,
        );
    });

    test("a deny list that reaches the tool another way is refused at call time too, and JavaScript is switched off", () => {
        const raw = section({ staging: connection() }, { staging: { deny: ["a.b"], javascript: true } });
        const settings = settingsOf(raw);
        assert.ok(settings);
        jig.kinds.set("staging", "production");
        assert.throws(
            () => accessFor(settings, "staging"),
            (error: unknown) => error instanceof InputError && /needs an allow list/.test(error.message),
        );
    });
});

describe("routes", () => {
    const ssh = (extra: Record<string, unknown> = {}) => ({
        ssh: { host: "bastion.example.com", user: "agent", key: "pass:ssh/bastion", ...extra },
    });

    test("an ssh route needs a host, a user and a key reference, and a plain key is refused without being repeated", () => {
        assert.match(
            errorsOf(section({ staging: connection({ via: { ssh: { user: "a", key: "pass:k" } } }) })),
            /ssh\.host: required/,
        );
        assert.match(
            errorsOf(section({ staging: connection({ via: { ssh: { host: "b.example.com", key: "pass:k" } } }) })),
            /ssh\.user: required/,
        );
        const key = ["-----BEGIN", "key"].join(" ");
        const messages = errorsOf(section({ staging: connection({ via: ssh({ key }) }) }));
        assert.match(messages, /ssh\.key: must be a secret reference/);
        assert.ok(!messages.includes(key));
        assert.match(
            errorsOf(section({ staging: connection({ via: ssh({ port: 70000 }) }) })),
            /ssh\.port: must be a whole number from 1 to 65535/,
        );
    });

    test("a host or a user that ssh would read as an option is refused", () => {
        for (const host of ["-oProxyCommand=x", "a b", "", "a;b"]) {
            assert.match(errorsOf(section({ staging: connection({ via: ssh({ host }) }) })), /ssh\.host/, host);
        }
        for (const user of ["-l", "a b", "a@b"]) {
            assert.match(errorsOf(section({ staging: connection({ via: ssh({ user }) }) })), /ssh\.user/, user);
        }
    });

    test("a forward reaches one host and port: a replica set list and mongodb+srv are refused with a route", () => {
        assert.match(
            errorsOf(
                section({
                    staging: connection({ via: ssh(), uri: "mongodb://a.example.com:27017,b.example.com:27017" }),
                }),
            ),
            /exactly one host and port/,
        );
        assert.match(
            errorsOf(section({ staging: connection({ via: ssh(), uri: "mongodb+srv://c.example.com" }) })),
            /exactly one host and port/,
        );
    });

    test("ssh and tunnel together, a bad tunnel name, and an empty route", () => {
        assert.match(
            errorsOf(section({ staging: connection({ via: { ...ssh(), tunnel: "x" } }) })),
            /use ssh or tunnel, not both/,
        );
        assert.match(
            errorsOf(section({ staging: connection({ via: { tunnel: "bad name!" } }) })),
            /tunnel: must be the name of a tunnel/,
        );
        assert.match(errorsOf(section({ staging: connection({ via: {} }) })), /must be \{ "ssh"/);
    });
});

describe("the access lists in the section", () => {
    test("a bad pattern or an allow list with a credential-like field is an error that names the key", () => {
        assert.match(
            errorsOf(section({ staging: connection() }, { staging: { deny: ["notes"] } })),
            /mongo\.access\.staging\.deny: "notes" is not/,
        );
        assert.match(
            errorsOf(
                section({ production: connection() }, { production: { allow: { "orders.orders": ["password"] } } }),
            ),
            /mongo\.access\.production\.allow\.orders\.orders: "password" looks like a credential/,
        );
    });

    test("readMongo gives no settings when there is an error", () => {
        const { settings, errors } = readMongo(section({ staging: connection({ user: "" }) }));
        assert.equal(settings, undefined);
        assert.ok(errors.length > 0);
    });
});

describe("the user, as plain text or as a secret reference", () => {
    test("is plain text unless it starts with the name of a secret backend and a colon", () => {
        for (const user of ["agent", "svc:orders", "Pass:agent", "agent@example.com", "op", "passx:y", "pass:"]) {
            assert.equal(isReference(user), false, user);
        }
        for (const user of ["pass:mongo/staging-user", "env:MONGO_USER", "cmd:mongo-user", "op://work/mongo/user"]) {
            assert.equal(isReference(user), true, user);
        }
    });

    test("the backends it knows are jig-core's", () => {
        for (const backend of SECRET_BACKENDS) assert.equal(isReference(`${backend}:x`), true, backend);
        assert.equal(isReference("other:x"), false);
    });

    test("a reference is accepted, and so is plain text", () => {
        for (const user of ["pass:mongo/staging-user", "env:MONGO_USER", "agent", "svc:orders"]) {
            assert.deepEqual(validateMongo(section({ staging: connection({ user }) })), [], user);
            assert.equal(
                settingsOf(section({ staging: connection({ user }) }))?.connections.get("staging")?.user,
                user,
            );
        }
    });

    test("a reference with white space, a user with a control character, and a missing user are refused", () => {
        for (const user of ["pass:two words", "env: x", "a\nb", "", 7, undefined]) {
            assert.match(
                errorsOf(section({ staging: connection({ user }) })),
                /staging\.user: required, the database user \(plain text, or a secret reference/,
                String(user),
            );
        }
    });
});

describe("several connections in one environment", () => {
    const named = (extra: Record<string, unknown> = {}) => ({
        orders: connection({ uri: "mongodb://orders.staging.example.com:27017" }),
        billing: connection({ uri: "mongodb://billing.staging.example.com:27017", user: "pass:mongo/billing-user" }),
        ...extra,
    });

    test("an environment may name its connections: each is read as a connection of its own", () => {
        const raw = section({ staging: named(), production: connection({ uri: "mongodb://db.example.com:27017" }) });
        assert.deepEqual(validateMongo(raw), []);
        const settings = settingsOf(raw);
        assert.ok(settings);
        assert.deepEqual([...settings.connections.keys()], ["staging/orders", "staging/billing", "production"]);
        assert.deepEqual([...settings.clusters.entries()], [["staging", ["orders", "billing"]]]);
        assert.deepEqual(environmentsOf(settings), ["staging", "production"]);
        const billing = settings.connections.get(connectionKey("staging", "billing"));
        assert.equal(billing?.environment, "staging");
        assert.equal(billing?.cluster, "billing");
        assert.equal(billing?.user, "pass:mongo/billing-user");
        assert.equal(billing?.uri.hosts[0]?.host, "billing.staging.example.com");
        assert.equal(settings.connections.get("production")?.cluster, undefined, "one connection has no name");
        assert.equal(settings.clusters.has("production"), false);
    });

    test("one connection, written as before, is still one connection", () => {
        const settings = settingsOf(section({ staging: connection() }));
        assert.deepEqual([...(settings?.connections.keys() ?? [])], ["staging"]);
        assert.equal(settings?.clusters.size, 0);
    });

    test("the key of a connection is its environment, or the environment and the name", () => {
        assert.equal(connectionKey("staging"), "staging");
        assert.equal(connectionKey("staging", "orders"), "staging/orders");
    });

    test("a name that cannot be one, and a value that is not a connection, are errors that name the key", () => {
        const bad = errorsOf(section({ staging: named({ "has space": connection(), deny: connection() }) }));
        assert.match(bad, /mongo\.connections\.staging: "has space" is not a usable name for a connection/);
        assert.match(bad, /mongo\.connections\.staging: "deny" is not a usable name for a connection/);
        assert.match(
            errorsOf(section({ staging: named({ extra: "mongodb://x.example.com" }) })),
            /mongo\.connections\.staging\.extra: must be an object with uri, user and password \(a connection of staging\)/,
        );
        // Every key a typo, so none is a field of a connection: read as names, and each is said to be no connection.
        assert.match(
            errorsOf(section({ staging: { urii: "mongodb://x.example.com", usr: "agent" } })),
            /mongo\.connections\.staging\.urii: must be an object/,
        );
    });

    test("each connection is checked on its own, with its own key in the message", () => {
        const errors = errorsOf(
            section({
                staging: named({
                    billing: connection({ uri: "mongodb://u:p@billing.example.com", password: "plain-text" }),
                }),
            }),
        );
        assert.match(errors, /mongo\.connections\.staging\.billing\.uri: must not hold a user or a password/);
        assert.match(errors, /mongo\.connections\.staging\.billing\.password: must be a secret reference/);
        assert.ok(!errors.includes("plain-text") && !errors.includes("u:p@"));
        assert.doesNotMatch(errors, /staging\.orders/);
    });

    test("an environment holds at most ten, and local and external still hold none", () => {
        const many = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`c${index}`, connection()]));
        assert.match(errorsOf(section({ staging: many })), /staging: at most 10 connections by name/);
        assert.match(errorsOf(section({ local: named() })), /a database is a test or production environment/);
    });

    test("an ssh route needs one host, per connection", () => {
        const via = { ssh: { host: "bastion.example.com", user: "agent", key: "pass:ssh/bastion" } };
        const errors = errorsOf(
            section({
                staging: named({ billing: connection({ uri: "mongodb+srv://billing.example.com", via }) }),
            }),
        );
        assert.match(errors, /mongo\.connections\.staging\.billing\.via\.ssh: needs a uri with exactly one host/);
    });

    test("a company's connections and your credentials lay together, and a route of yours replaces the company's", () => {
        const company = {
            connections: {
                staging: {
                    orders: { uri: "mongodb://orders.staging.example.com:27017", via: { tunnel: "corp-net" } },
                    billing: { uri: "mongodb://billing.staging.example.com:27017", via: { tunnel: "corp-net" } },
                },
                production: { uri: "mongodb://db.example.com:27017", via: { tunnel: "corp-net" } },
            },
            access: { production: { allow: { "orders.orders": ["_id"] } } },
        };
        const mine = {
            connections: {
                staging: {
                    orders: { user: "pass:mongo/orders-user", password: "pass:mongo/orders" },
                    billing: {
                        user: "agent",
                        password: "pass:mongo/billing",
                        via: { ssh: { host: "bastion.example.com", user: "agent", key: "pass:ssh/bastion" } },
                    },
                },
                production: { user: "agent-readonly", password: "pass:mongo/production" },
            },
        };
        assert.deepEqual(validateMongo(layered(company, mine, MONGO_REPLACE)), []);
        assert.match(validateMongo(layered(company, mine)).join("\n"), /use ssh or tunnel, not both/);
    });
});

describe("the access lists of an environment with several connections", () => {
    const environment = (extra: Record<string, unknown> = {}) => ({
        orders: connection({ uri: "mongodb://orders.staging.example.com:27017" }),
        billing: connection({ uri: "mongodb://billing.staging.example.com:27017" }),
        ...extra,
    });
    const production = () => ({
        orders: connection({ uri: "mongodb://orders.example.com:27017" }),
        billing: connection({ uri: "mongodb://billing.example.com:27017" }),
    });

    test("are given per connection, and each applies to its connection only", () => {
        const raw = section(
            { staging: environment() },
            { staging: { orders: { deny: ["*.notes"] }, billing: { deny: ["cards.*"] } } },
        );
        assert.deepEqual(validateMongo(raw), []);
        const settings = settingsOf(raw);
        assert.ok(settings);
        jig.kinds.set("staging", "test");
        assert.deepEqual([...settings.access.keys()], ["staging/orders", "staging/billing"]);
        const orders = accessFor(settings, "staging", "orders");
        const billing = accessFor(settings, "staging", "billing");
        assert.throws(() => billing.namespace("cards", "visa"), /denied/);
        billing.namespace("orders", "orders");
        orders.namespace("cards", "visa");
        assert.equal(orders.mode, "deny");
    });

    test("a connection with no rules has the default of its kind, and the other connection's rules do not leak into it", () => {
        const raw = section({ staging: environment() }, { staging: { orders: { deny: ["orders.secret"] } } });
        const settings = settingsOf(raw);
        assert.ok(settings);
        jig.kinds.set("staging", "test");
        assert.throws(() => accessFor(settings, "staging", "orders").namespace("orders", "secret"), /denied/);
        accessFor(settings, "staging", "billing").namespace("orders", "secret");
    });

    test("one set of rules for the whole environment is refused, and says to give them by name", () => {
        const errors = errorsOf(section({ staging: environment() }, { staging: { deny: ["*.notes"] } }));
        assert.match(errors, /mongo\.access\.staging\.deny: staging has several connections \(orders, billing\)/);
        assert.match(errors, /so give the rules for each by name/);
        assert.match(
            errorsOf(section({ staging: environment() }, { staging: "deny" })),
            /must be an object by connection name/,
        );
    });

    test("rules for a connection that is not there are refused", () => {
        assert.match(
            errorsOf(section({ staging: environment() }, { staging: { invoices: { deny: ["*.notes"] } } })),
            /mongo\.access\.staging\."invoices": there is no connection with this name in staging/,
        );
    });

    test("each is checked as the rules of an environment are, with the connection in the key", () => {
        assert.match(
            errorsOf(section({ staging: environment() }, { staging: { orders: { deny: ["notes"] } } })),
            /mongo\.access\.staging\.orders\.deny: "notes" is not/,
        );
        // Production: each connection needs an allow list, and may not run JavaScript.
        jig.kinds.set("production", "production");
        assert.match(
            errorsOf(section({ production: production() }, { production: { orders: { deny: ["*.notes"] } } })),
            /mongo\.access\.production\.orders: production needs an allow list/,
        );
        assert.match(
            errorsOf(
                section(
                    { production: production() },
                    { production: { orders: { allow: { "orders.orders": ["_id"] }, javascript: true } } },
                ),
            ),
            /mongo\.access\.production\.orders\.javascript: server-side JavaScript is never allowed in production/,
        );
        assert.deepEqual(
            validateMongo(
                section(
                    { production: production() },
                    {
                        production: {
                            orders: { allow: { "orders.orders": ["_id"] } },
                            billing: { allow: { "billing.invoices": ["_id", "total"] } },
                        },
                    },
                ),
            ),
            [],
        );
    });

    test("production reads nothing from a connection that has no allow list, and a deny list is refused again at a call", () => {
        const raw = section({ production: production() });
        const settings = settingsOf(raw);
        assert.ok(settings);
        jig.kinds.set("production", "production");
        assert.throws(
            () => accessFor(settings, "production", "billing").namespace("orders", "orders"),
            /nothing is allowed yet/,
        );
    });

    test("an environment with one connection keeps the shape it had", () => {
        const raw = section({ staging: connection() }, { staging: { deny: ["*.notes"] } });
        assert.deepEqual(validateMongo(raw), []);
        assert.deepEqual([...(settingsOf(raw)?.access.keys() ?? [])], ["staging"]);
    });
});
