// A user's own jig.json laid over the company's defaults. The user writes only what they change: objects merge key by key, a list or a
// string of theirs replaces the company's, and where a plugin says an object is one choice among several (`replace`) or that two keys
// exclude each other (`oneOf`), theirs takes the place of the company's, so the two never make a mix that is neither.
//
// Each test starts the real plugins with the company's defaults and a jig.json of one small change, and reads back the section the
// plugin would get.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { DEFAULTS } from "../src/defaults/index.ts";
import { logsDefaults } from "../src/defaults/logs.ts";
import { call } from "./support/call.ts";
import { startWorld } from "./support/world.ts";
import type { World } from "./support/world.ts";

let world: World | undefined;
afterEach(async () => {
    await world?.close();
    world = undefined;
});

/** Starts a world whose jig.json is `personal`, checks nothing is reported as wrong, and returns it. */
async function withPersonal(personal: unknown): Promise<World> {
    world = await startWorld({ personal });
    assert.deepEqual(await world.problems(), [], "the mix is valid");
    return world;
}

const section = (w: World, name: string): Record<string, any> => w.api.config.section(name) as Record<string, any>;
const defaults = (name: string): Record<string, any> => DEFAULTS[name] as Record<string, any>;

describe("objects merge key by key", () => {
    test("only jira.site: the company's sign-in and fields stay", async () => {
        const w = await withPersonal({ jira: { site: "https://acme-eu.atlassian.net" } });
        assert.deepEqual(section(w, "jira"), { ...defaults("jira"), site: "https://acme-eu.atlassian.net" });
    });

    test("one index of one logs environment: the rest of the backend and the environments stay", async () => {
        const w = await withPersonal({ logs: { environments: { staging: { index: "my-staging-*" } } } });
        const logs = section(w, "logs");
        assert.deepEqual(logs.backend, logsDefaults.backend);
        assert.deepEqual(logs.environments.staging, { ...logsDefaults.environments.staging, index: "my-staging-*" });
        assert.deepEqual(logs.environments.dev, logsDefaults.environments.dev);
    });

    test("one setting of one database connection: its address, password and route stay", async () => {
        const w = await withPersonal({ mongo: { connections: { dev: { user: "jdoe" } } } });
        const dev = section(w, "mongo").connections.dev;
        assert.deepEqual(dev, { ...defaults("mongo").connections.dev, user: "jdoe" });
    });

    test("one colour of the company palette: the rest of the palette stays", async () => {
        const w = await withPersonal({ theme: { palettes: { acme: { vars: { accent: "#44CCAA" } } } } });
        assert.deepEqual(section(w, "theme").palettes.acme, {
            base: "jig-signal",
            vars: { accent: "#44CCAA", heading: "#FFB454" },
        });
    });

    test("a section that has no defaults is checked as the user wrote it", async () => {
        const w = await withPersonal({ lens: { port: 3311 } });
        assert.deepEqual(w.api.config.section("lens"), { port: 3311 });
    });
});

describe("a list or a string of the user's replaces the company's", () => {
    test("the fields update may set, the protected branches, the ticket pattern", async () => {
        const w = await withPersonal({
            jira: { updateFields: ["summary", "labels"] },
            git: { protected: ["main"] },
            memory: { ticketPattern: "(ACME|PLAT)-\\d+" },
        });
        assert.deepEqual(section(w, "jira").updateFields, ["summary", "labels"]);
        assert.deepEqual(section(w, "git").protected, ["main"]);
        assert.equal(section(w, "memory").ticketPattern, "(ACME|PLAT)-\\d+");
        assert.equal(section(w, "git").prTitle, defaults("git").prTitle, "while the rest of git stays");
    });

    test("the Jira projects", async () => {
        assert.deepEqual(
            section(await withPersonal({}), "jira").projects,
            ["ACME"],
            "the company's, when the user says nothing",
        );
        await world?.close();
        const w = await withPersonal({ jira: { projects: ["ACME", "PLAT"] } });
        assert.deepEqual(section(w, "jira").projects, ["ACME", "PLAT"]);
        assert.equal(section(w, "jira").site, defaults("jira").site, "while the rest of jira stays");
    });

    test("a create in a project the list leaves out is refused before anyone is asked", async () => {
        const w = await withPersonal({});
        const outcome = await call(w, "jira", { action: "create", project: "OTHER", type: "Bug", summary: "A bug" });
        assert.equal(outcome.blocked, true);
        assert.match(outcome.reason ?? "", /OTHER is not one of your projects \(ACME\)/);
        assert.equal(w.ui.selects.length, 0, "the user was not asked");
    });

    test("the sandbox's denied hosts", async () => {
        const w = await withPersonal({ sandbox: { network: { deny: ["mongo.prod.acme.example"] } } });
        assert.deepEqual(section(w, "sandbox").network.deny, ["mongo.prod.acme.example"]);
    });
});

describe("where an object is one choice among several, the user's replaces the company's whole (replace)", () => {
    test("jira.auth: a sign-in service in place of the email and token, not beside them", async () => {
        const w = await withPersonal({ jira: { auth: { signIn: "acme-sso" } } });
        assert.deepEqual(section(w, "jira").auth, { signIn: "acme-sso" });
        assert.equal(section(w, "jira").site, defaults("jira").site);
    });

    test("jira.auth: the user's own email and token", async () => {
        const auth = { email: "jdoe@acme.example", token: "env:JDOE_JIRA_TOKEN" };
        const w = await withPersonal({ jira: { auth } });
        assert.deepEqual(section(w, "jira").auth, auth);
    });

    test("logs.backend.auth: the user's own API key in place of the company's sign-in service", async () => {
        const w = await withPersonal({ logs: { backend: { auth: { apiKey: "env:JDOE_LOGS_KEY" } } } });
        const backend = section(w, "logs").backend;
        assert.deepEqual(backend, {
            type: "elasticsearch",
            url: "https://logs.acme.example",
            auth: { apiKey: "env:JDOE_LOGS_KEY" },
        });
    });

    test("mongo.connections.<env>.via: an ssh route in place of the company's tunnel", async () => {
        const via = { ssh: { host: "bastion.acme.example", user: "jdoe", key: "pass:ssh/acme" } };
        const w = await withPersonal({ mongo: { connections: { staging: { via } } } });
        assert.deepEqual(section(w, "mongo").connections.staging.via, via);
        assert.deepEqual(
            section(w, "mongo").connections.prod.via,
            { tunnel: "acme-bastion" },
            "prod keeps the company's",
        );
    });

    test("api.environments.<name>: a sign-in service in place of the company's transport", async () => {
        const w = await withPersonal({
            api: { environments: { Staging: { environment: "staging", signIn: "acme-sso" } } },
        });
        assert.deepEqual(section(w, "api").environments.Staging, { environment: "staging", signIn: "acme-sso" });
        assert.equal(section(w, "api").environments.Dev, "dev");
    });

    test("ops...deploy: another deploy method in place of Helm", async () => {
        const deploy = { method: "kubectl-image", workload: "deployment/billing-worker", container: "billing-worker" };
        const w = await withPersonal({
            ops: { services: { "billing-worker": { environments: { dev: { deploy } } } } },
        });
        const dev = section(w, "ops").services["billing-worker"].environments.dev;
        assert.deepEqual(dev.deploy, deploy);
        assert.deepEqual(
            dev.runtime,
            defaults("ops").services["billing-worker"].environments.dev.runtime,
            "its runtime stays",
        );
    });
});

describe("where two keys exclude each other, the user's one displaces the company's other (oneOf)", () => {
    test("logs.backend.transport: the company's sign-in service is dropped, not left beside it", async () => {
        const w = await withPersonal({ logs: { backend: { transport: "acme-gateway" } } });
        assert.deepEqual(section(w, "logs").backend, {
            type: "elasticsearch",
            url: "https://logs.acme.example",
            transport: "acme-gateway",
        });
    });
});

describe("a mistake is reported with its key, and the plugin does not run half set up", () => {
    test("a Jira address in plain http", async () => {
        world = await startWorld({ personal: { jira: { site: "http://acme.atlassian.net" } } });
        const problems = await world.problems();
        assert.equal(problems.length, 1, problems.join("\n"));
        assert.match(problems[0] ?? "", /jira\.site: must be an https address/);
        assert.equal(world.api.config.section("jira"), undefined);
        assert.deepEqual(section(world, "logs"), defaults("logs"), "while the other sections are fine");
    });

    test("a token pasted where a secret reference belongs is refused, and not repeated", async () => {
        const pasted = ["pasted", "token", "0123456789"].join("-");
        world = await startWorld({ personal: { acme: { sso: { token: pasted } } } });
        const problems = (await world.problems()).join("\n");
        assert.match(problems, /acme\.sso\.token: must be a secret reference/);
        assert.equal(problems.includes(pasted), false);
        assert.equal(world.api.config.section("acme"), undefined, "the company's own section is dropped too");
    });

    test("an unknown field of the company's own section", async () => {
        world = await startWorld({ personal: { acme: { gateway: { colour: "blue" } } } });
        assert.match((await world.problems()).join("\n"), /acme\.gateway\.colour: unknown field/);
    });
});
