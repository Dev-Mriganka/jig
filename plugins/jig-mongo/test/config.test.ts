// The `mongo` section of jig.json: what is valid, and the refusals that keep a credential out of a connection string and a
// deny list out of production.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { accessFor, readMongo, settingsOf, validateMongo } from "../src/config.ts";
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
        assert.equal((settingsOf(raw)?.connections.get("qa")?.via as { port: number }).port, 2222);
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
