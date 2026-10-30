// A company's defaults for a plugin's section of jig.json: the user's section is checked laid over them (so they write
// only what they change), defaults that need something from the user leave the plugin unconfigured and say so in
// `/jig`, and a plugin names the keys that replace the company's instead of merging into them.
//
// The plugin is a fake with the shape of a Jira tool: a `site`, and an `auth` that is exactly one of `{ token }` or
// `{ transport }`. The company is a fake plugin that gives defaults for it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildApi } from "../src/api.ts";
import { describeProblem } from "../src/config.ts";
import type { JigApi } from "../src/contract.ts";
import { layered } from "../src/section-defaults.ts";
import { createState, loadPersonalConfig } from "../src/state.ts";
import { start } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { tempState } from "./support/state.ts";

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** The fake plugin's check: `{ site: <string>, auth: { token } or { transport } }`, and nothing else. */
function jiraCheck(raw: unknown): string[] {
    if (!isObject(raw)) return ["jira: must be an object"];
    const errors: string[] = [];
    for (const key of Object.keys(raw)) if (key !== "site" && key !== "auth") errors.push(`jira.${key}: unknown field`);
    if (typeof raw.site !== "string") errors.push("jira.site: required, the address of your Jira");
    if (!isObject(raw.auth)) errors.push("jira.auth: required, { token } or { transport }");
    else {
        const keys = Object.keys(raw.auth);
        if (keys.length !== 1 || !(keys[0] === "token" || keys[0] === "transport")) {
            errors.push("jira.auth: use exactly one of token or transport");
        }
    }
    return errors;
}

const REPLACE = { replace: ["auth"] };
const COMPANY_AUTH = { auth: { transport: "corp-proxy" } };

let dir: string;
let counter = 0;
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "jig-layers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A jig-core state whose file holds `personal`, a fake Jira plugin registered, and nothing loaded yet. */
function setup(personal: unknown, options: { replace?: boolean } = { replace: true }) {
    const file = path.join(dir, `jig-${counter++}.json`);
    writeFileSync(file, typeof personal === "string" ? personal : JSON.stringify(personal));
    const state = createState({} as ExtensionAPI);
    const api = buildApi(state);
    api.config.registerSection("jira", jiraCheck, options.replace === false ? undefined : REPLACE);
    const load = () => loadPersonalConfig(state, file);
    const problems = () => state.policy().problems.map((problem) => describeProblem(problem));
    return { state, api, file, load, problems };
}

describe("your section is checked laid over the company's defaults", () => {
    test("you write only what you change: the company gives the sign-in, you give the site", () => {
        const { api, load, problems } = setup({ jira: { site: "https://jira.example.com" } });
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        load();
        assert.deepEqual(api.config.section("jira"), {
            site: "https://jira.example.com",
            auth: { transport: "corp-proxy" },
        });
        assert.deepEqual(problems(), []);
    });

    test("a section nobody gave defaults for is checked as you wrote it, and lost if it is not valid", () => {
        const { api, load, problems, file } = setup({ jira: { site: "https://jira.example.com" } });
        load();
        assert.equal(api.config.section("jira"), undefined);
        assert.deepEqual(problems(), [`${file}: jira: jira.auth: required, { token } or { transport }`]);
    });

    test("defaults for another section change nothing here", () => {
        const { api, load, problems } = setup({ jira: { site: "https://jira.example.com" } });
        api.config.addSectionDefaults("logs", COMPANY_AUTH);
        load();
        assert.equal(api.config.section("jira"), undefined);
        assert.equal(problems().length, 1);
    });

    test("your own values win over the company's, key by key", () => {
        const { api, load } = setup({ jira: { site: "https://mine.example.com" } });
        api.config.addSectionDefaults("jira", { site: "https://company.example.com", ...COMPANY_AUTH });
        load();
        assert.deepEqual(api.config.section("jira"), { site: "https://mine.example.com", ...COMPANY_AUTH });
    });

    test("a mix that is not valid is reported with the file and the key, and the section is lost", () => {
        const { api, load, problems, file } = setup({ jira: { site: "https://jira.example.com" } });
        api.config.addSectionDefaults("jira", { ...COMPANY_AUTH, colour: "red" });
        load();
        assert.equal(api.config.section("jira"), undefined);
        assert.deepEqual(problems(), [
            `${file}: jira: the company defaults for "jira", with your settings laid over them, are not valid: jira.colour: unknown field`,
        ]);
    });

    test("a mix that is not valid leaves a section that is complete on its own as you wrote it, and says so", () => {
        const mine = { site: "https://jira.example.com", auth: { token: "pass:work/jira" } };
        const { api, load, problems } = setup({ jira: mine });
        api.config.addSectionDefaults("jira", { colour: "red" });
        load();
        assert.deepEqual(api.config.section("jira"), mine);
        assert.equal(problems().length, 1);
        assert.match(problems()[0] ?? "", /jira\.colour: unknown field \(your own section is used as you wrote it\)$/);
    });

    test("the problem is in the list that /jig shows and that the session start announces", async () => {
        let harness: Harness | undefined;
        const kept = tempState();
        kept.start();
        try {
            harness = await start({
                config: { jira: { site: "https://jira.example.com" } },
                plugins: (api) => {
                    api.config.registerSection("jira", jiraCheck, REPLACE);
                    api.config.addSectionDefaults("jira", { ...COMPANY_AUTH, colour: "red" });
                },
            });
            const said = harness.ui.notifications.map((entry) => entry.message).join("\n");
            assert.match(said, /jig-core: 1 configuration problem/);
            assert.match(said, /the company defaults for "jira", with your settings laid over them, are not valid/);
        } finally {
            await harness?.shutdown();
            kept.stop();
        }
    });

    test("defaults that come after the file was read are still laid under your section", () => {
        const { api, load, problems } = setup({ jira: { site: "https://jira.example.com" } });
        load();
        assert.equal(api.config.section("jira"), undefined, "alone it is not valid");
        assert.equal(problems().length, 1);
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        assert.deepEqual(api.config.section("jira"), {
            site: "https://jira.example.com",
            auth: { transport: "corp-proxy" },
        });
        assert.deepEqual(problems(), []);
    });

    test("the check may come after the defaults and the file", () => {
        const file = path.join(dir, "jig-late.json");
        writeFileSync(file, JSON.stringify({ jira: { site: "https://jira.example.com" } }));
        const state = createState({} as ExtensionAPI);
        const api = buildApi(state);
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        loadPersonalConfig(state, file);
        assert.equal(state.policy().problems.length, 1, "unknown until the plugin registers its section");
        api.config.registerSection("jira", jiraCheck, REPLACE);
        assert.deepEqual(api.config.section("jira"), {
            site: "https://jira.example.com",
            auth: { transport: "corp-proxy" },
        });
        assert.deepEqual(state.policy().problems, []);
    });

    test("a file that cannot be read still leaves the company's defaults, when they are complete", () => {
        const { api, load } = setup("{ not json");
        api.config.addSectionDefaults("jira", { site: "https://jira.example.com", ...COMPANY_AUTH });
        load();
        assert.deepEqual(api.config.section("jira"), { site: "https://jira.example.com", ...COMPANY_AUTH });
    });

    test("a section of yours that is not an object is an error, with or without defaults", () => {
        const { api, load, problems } = setup({ jira: "https://jira.example.com" });
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        load();
        assert.equal(api.config.section("jira"), undefined);
        assert.equal(problems().length, 1);
    });
});

describe("defaults that need something only you can give", () => {
    test("leave the plugin unconfigured without a problem, and with no section of yours", () => {
        const { state, api, load, problems } = setup({});
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        load();
        assert.equal(api.config.section("jira"), undefined);
        assert.deepEqual(problems(), []);
        assert.deepEqual(state.startupProblems, []);
        assert.deepEqual([...state.personal.incomplete.keys()], ["jira"]);
        assert.deepEqual(state.personal.incomplete.get("jira"), ["jira.site: required, the address of your Jira"]);
    });

    test("are not incomplete once they are valid alone, and then they are the section", () => {
        const { state, api, load, problems } = setup({});
        const complete = { site: "https://jira.example.com", ...COMPANY_AUTH };
        api.config.addSectionDefaults("jira", complete);
        load();
        assert.deepEqual(api.config.section("jira"), complete);
        assert.equal(state.personal.incomplete.size, 0);
        assert.deepEqual(problems(), []);
    });

    test("are complete as soon as you write your part", () => {
        const { state, api, load, problems } = setup({ jira: { site: "https://jira.example.com" } });
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        load();
        assert.ok(api.config.section("jira"));
        assert.equal(state.personal.incomplete.size, 0);
        assert.deepEqual(problems(), []);
    });

    test("do not hide a section of yours that is empty: you wrote one, and it is checked over them", () => {
        const { api, load, problems } = setup({ jira: {} });
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        load();
        assert.equal(api.config.section("jira"), undefined);
        assert.match(problems()[0] ?? "", /jira\.site: required/);
    });

    test("a plugin nobody registered is not checked, and is not incomplete", () => {
        const { state, api, load } = setup({});
        api.config.addSectionDefaults("elsewhere", { anything: 1 });
        load();
        assert.deepEqual(api.config.section("elsewhere"), { anything: 1 });
        assert.equal(state.personal.incomplete.size, 0);
    });

    test("/jig says the company defaults are incomplete, and the session start does not announce them", async () => {
        const kept = tempState();
        kept.start();
        let harness: Harness | undefined;
        try {
            harness = await start({
                plugins: (api: JigApi) => {
                    api.config.registerSection("jira", jiraCheck, REPLACE);
                    api.config.addSectionDefaults("jira", COMPANY_AUTH);
                },
            });
            assert.deepEqual(
                harness.ui.notifications.filter((entry) => entry.type === "error"),
                [],
                "no start-up problem",
            );
            assert.equal(harness.api.config.section("jira"), undefined);

            const command = harness.host.commands.get("jig");
            assert.ok(command);
            await command.handler("", harness.ctx as never);
            const shown = harness.ui.notifications.map((entry) => entry.message).join("\n");
            assert.match(shown, /Plugin sections in the file: jira \(company defaults incomplete\)/);
            assert.match(
                shown,
                /Company defaults for "jira" are incomplete without a section of yours, so the plugin is not configured: jira\.site: required/,
            );
            assert.doesNotMatch(shown, /Configuration problems/);
        } finally {
            await harness?.shutdown();
            kept.stop();
        }
    });
});

describe("keys that replace the company's instead of merging into it", () => {
    test("your auth replaces the company's whole, so the two do not make a mix", () => {
        const { api, load, problems } = setup({
            jira: { site: "https://jira.example.com", auth: { token: "pass:work/jira" } },
        });
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        load();
        assert.deepEqual(api.config.section("jira"), {
            site: "https://jira.example.com",
            auth: { token: "pass:work/jira" },
        });
        assert.deepEqual(problems(), []);
    });

    test("without it the two merge, and the result is the invalid mix the plugin's check refuses", () => {
        const { api, load, problems } = setup(
            { jira: { site: "https://jira.example.com", auth: { token: "pass:work/jira" } } },
            { replace: false },
        );
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        load();
        // The section as written is complete, so it is used, and the mismatch is said.
        assert.match(problems()[0] ?? "", /jira\.auth: use exactly one of token or transport/);
    });

    test("the company's auth stays when you do not write one", () => {
        const { api, load } = setup({ jira: { site: "https://jira.example.com" } });
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        load();
        assert.deepEqual((api.config.section("jira") as { auth: unknown }).auth, { transport: "corp-proxy" });
    });

    test("registering the section again replaces the keys, and a plugin that names none merges as before", () => {
        const { state, api, load } = setup({
            jira: { site: "https://jira.example.com", auth: { token: "pass:work/jira" } },
        });
        api.config.registerSection("jira", jiraCheck, REPLACE);
        assert.deepEqual(state.sectionReplace.get("jira"), ["auth"]);
        api.config.registerSection("jira", jiraCheck);
        assert.equal(state.sectionReplace.has("jira"), false);
        api.config.registerSection("jira", jiraCheck, { replace: [] });
        assert.equal(state.sectionReplace.has("jira"), false);
        api.config.registerSection("jira", jiraCheck, REPLACE);
        api.config.addSectionDefaults("jira", COMPANY_AUTH);
        load();
        assert.ok(api.config.section("jira"));
    });

    test("the keys are checked when the section is registered", () => {
        const { api } = setup({});
        for (const replace of ["auth", [""], [1], [["auth"]], { auth: true }]) {
            assert.throws(
                () => api.config.registerSection("jira", jiraCheck, { replace } as never),
                /replace must be a list of paths/,
                JSON.stringify(replace),
            );
        }
    });
});

describe("layered, with keys that replace", () => {
    const company = {
        site: "https://company.example.com",
        auth: { transport: "corp-proxy" },
        backend: { type: "loki", auth: { signIn: "corp-sso" }, tenant: "orders" },
        services: {
            "orders-api": { ci: { system: "gitlab", url: "https://ci.example.com", auth: { signIn: "corp-sso" } } },
            "billing-api": { ci: { system: "gitlab", auth: { signIn: "corp-sso" } } },
        },
    };

    test("a top-level key replaces whole, and the others still merge", () => {
        const mine = { auth: { token: "env:T" }, backend: { tenant: "mine" } };
        const out = layered(company, mine, ["auth"]) as typeof company;
        assert.deepEqual(out.auth, { token: "env:T" });
        assert.deepEqual(out.backend, { type: "loki", auth: { signIn: "corp-sso" }, tenant: "mine" });
        assert.equal(out.site, "https://company.example.com");
    });

    test("a path goes down through objects", () => {
        const out = layered(company, { backend: { auth: { token: "env:T" } } }, ["backend.auth"]) as typeof company;
        assert.deepEqual(out.backend, { type: "loki", auth: { token: "env:T" }, tenant: "orders" });
    });

    test("a * stands for any one name, such as every service of a catalog", () => {
        const mine = { services: { "orders-api": { ci: { auth: { token: "env:T" } } } } };
        const out = layered(company, mine, ["services.*.ci.auth"]) as typeof company;
        assert.deepEqual(out.services["orders-api"].ci, {
            system: "gitlab",
            url: "https://ci.example.com",
            auth: { token: "env:T" },
        });
        assert.deepEqual(out.services["billing-api"], company.services["billing-api"], "untouched");
    });

    test("a path matches at its own depth only", () => {
        const mine = { backend: { auth: { token: "env:T" } } };
        // `auth` is top-level here: the auth inside `backend` still merges.
        const out = layered(company, mine, ["auth"]) as typeof company;
        assert.deepEqual(out.backend.auth, { signIn: "corp-sso", token: "env:T" });
        // And `*` is one level, not any depth.
        const deep = layered(company, mine, ["*"]) as typeof company;
        assert.deepEqual(deep.backend, { auth: { token: "env:T" } }, "the backend itself is replaced");
        const none = layered(company, mine, ["*.auth.x"]) as typeof company;
        assert.deepEqual(none.backend.auth, { signIn: "corp-sso", token: "env:T" });
    });

    test("a key you do not write leaves the company's alone, and a value that is not an object replaces as ever", () => {
        const kept = layered(company, { site: "https://mine.example.com" }, ["auth"]) as typeof company;
        assert.deepEqual(kept.auth, { transport: "corp-proxy" });
        assert.equal(kept.site, "https://mine.example.com");
        assert.deepEqual(layered({ auth: { transport: "x" } }, { auth: "env:T" }, ["auth"]), { auth: "env:T" });
        assert.deepEqual(layered({ list: [1, 2] }, { list: [3] }, ["list"]), { list: [3] });
    });

    test("neither side is changed", () => {
        const theirs = { auth: { transport: "x" }, site: "a" };
        const mine = { auth: { token: "y" } };
        const out = layered(theirs, mine, ["auth"]);
        assert.deepEqual(theirs, { auth: { transport: "x" }, site: "a" });
        assert.deepEqual(mine, { auth: { token: "y" } });
        assert.notEqual(out, theirs);
    });

    test("a key called __proto__ in your file is only a key", () => {
        const mine = JSON.parse('{"__proto__": {"polluted": true}, "site": "s"}');
        const out = layered({ auth: { transport: "x" } }, mine, ["auth"]) as Record<string, unknown>;
        assert.equal(Object.getPrototypeOf(out), Object.prototype);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
        assert.equal(out.polluted, undefined);
        assert.deepEqual(Object.keys(out).sort(), ["__proto__", "auth", "site"]);
    });

    test("with no keys it is the merge it always was", () => {
        assert.deepEqual(layered({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [9] }), {
            a: { b: 1, c: 3 },
            d: [9],
        });
        assert.equal(layered("theirs", undefined), "theirs");
        assert.deepEqual(layered(undefined, { a: 1 }), { a: 1 });
    });
});

describe("keys that exclude each other (oneOf)", () => {
    const company = { backend: { type: "elasticsearch", url: "https://logs.example.com", transport: "corp" } };
    const rivals = [["backend.auth", "backend.transport"]];

    test("your key displaces the company's rival, and the rest of the object still merges", () => {
        const mine = { backend: { auth: { token: "env:LOGS_TOKEN" } } };
        assert.deepEqual(layered(company, mine, ["backend.auth"], rivals), {
            backend: { type: "elasticsearch", url: "https://logs.example.com", auth: { token: "env:LOGS_TOKEN" } },
        });
    });

    test("without it the two end up side by side", () => {
        const mine = { backend: { auth: { token: "env:LOGS_TOKEN" } } };
        const merged = layered(company, mine, ["backend.auth"]) as { backend: Record<string, unknown> };
        assert.deepEqual(Object.keys(merged.backend).sort(), ["auth", "transport", "type", "url"]);
    });

    test("the company's choice stays when you set neither", () => {
        assert.deepEqual(layered(company, { backend: { url: "https://other.example.com" } }, [], rivals), {
            backend: { type: "elasticsearch", url: "https://other.example.com", transport: "corp" },
        });
    });

    test("setting the same key as the company keeps yours, as usual", () => {
        assert.deepEqual(layered(company, { backend: { transport: "mine" } }, [], rivals), {
            backend: { type: "elasticsearch", url: "https://logs.example.com", transport: "mine" },
        });
    });

    test("a * in the object's path matches every name", () => {
        const theirs = { services: { a: { ci: { token: "env:A" } }, b: { ci: { token: "env:B" } } } };
        const mine = { services: { a: { ci: { signIn: "corp" } } } };
        assert.deepEqual(layered(theirs, mine, [], [["services.*.ci.token", "services.*.ci.signIn"]]), {
            services: { a: { ci: { signIn: "corp" } }, b: { ci: { token: "env:B" } } },
        });
    });

    test("registering checks each list: two or more paths, in one object", () => {
        const state = createState(undefined as unknown as ExtensionAPI);
        const api: JigApi = buildApi(state);
        const check = () => [];
        assert.throws(() => api.config.registerSection("logs", check, { oneOf: [["backend.auth"]] }), /two or more/);
        assert.throws(
            () => api.config.registerSection("logs", check, { oneOf: [["backend.auth", "transport"]] }),
            /in one object/,
        );
        api.config.registerSection("logs", check, { oneOf: rivals });
        assert.deepEqual(state.sectionOneOf.get("logs"), rivals);
    });
});
