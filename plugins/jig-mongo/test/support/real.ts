// The `mongo` tool as it runs under Pi against a real MongoDB: the plugin connects with the driver and starts `ssh` through
// the fake jig-core's `exec.run` (which starts real programs from an argument list), and only the screen and the secret store are
// the fakes the other tests of this plugin use. Used by the tests in `it/`, which run when the address of a replica set is set.
import type { TestContext } from "node:test";
import { MongoClient } from "mongodb";
import type { MongoClientOptions } from "mongodb";
import { must } from "../../../../test/support/it.ts";
import { setupHarness } from "./harness.ts";
import type { Harness } from "./harness.ts";

/** The reference under which the tests' database password is held. */
export const PASSWORD_REFERENCE = "env:JIG_IT_MONGO_PASSWORD";

export interface Accounts {
    /** May read, write and change indexes in any database. */
    user: string;
    /** May only read. */
    readonlyUser: string;
    password: string;
}

export function accounts(): Accounts {
    return {
        user: must("JIG_IT_MONGO_USER"),
        readonlyUser: must("JIG_IT_MONGO_READONLY_USER"),
        password: must("JIG_IT_MONGO_PASSWORD"),
    };
}

/** A `connections` entry of the `mongo` section. */
export function connection(uri: string, user: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { uri, user, password: PASSWORD_REFERENCE, ...extra };
}

/** The tool with a section of jig.json and the database password, and a database that is the real one. */
export function realHarness(t: TestContext, section: Record<string, unknown>): Harness {
    const h = setupHarness({}, true);
    h.configure(section);
    h.jig.secrets.set(PASSWORD_REFERENCE, accounts().password);
    t.after(() => h.close());
    return h;
}

/**
 * A client of the test's own, to seed data and to look at what the tool did. It signs in as the user that may write, over the
 * address the test host can reach.
 */
export async function rawClient(uri: string, options: MongoClientOptions = {}): Promise<MongoClient> {
    const who = accounts();
    const client = new MongoClient(uri, {
        auth: { username: who.user, password: who.password },
        authSource: "admin",
        serverSelectionTimeoutMS: 20_000,
        ...options,
    });
    await client.connect();
    return client;
}
