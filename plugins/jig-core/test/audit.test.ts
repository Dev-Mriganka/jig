// The audit: what a plugin promises about its actions, checked from its own code rather than by reading it.
//
//  1. What its documentation says. Every action a tool offers is a row of a table in the plugin's README or its docs, and
//     the row's effect and approval are the ones `classify` returns. A write that turns into a read, or a dialog that turns
//     into a review screen, is a documentation change and a code change in one commit, or this fails.
//  2. What `classify` decides. The environment, effect and approval of every action are recorded in TABLE below, and every
//     action of a tool whose call names an environment also gets a production line, from the same input with production in
//     place of staging. A line that says `refused` is a tool refusing production by name; any other refusal is `needs
//     input`, so a wrong reason fails loudly. A change in either shows in a diff.
//  3. What its tests name. The report counts the actions no test in the plugin names, so an untested action is seen rather
//     than assumed. It is a report: an action can be covered by a shared fixture.
//
// The plugins are loaded as Pi loads them, into a session with a `jig.json` of its own: two environments (staging, a test
// environment, and the built-in production), a mongo connection for each, an api collection whose hosts are variables of
// its environment files, and an ops catalog with a service, its environments and CI jobs. Without it, `classify` cannot
// answer for mongo, api, ops and logs, and those are the actions where a wrong answer matters most.
//
// A tool without an `action` parameter (bash, the file tools, a single-purpose tool) is skipped: it has no action to audit.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { jig, withdrawJig } from "../src/client.ts";
import type { CallClass, JigApi, ToolDeclaration } from "../src/contract.ts";
import { decide } from "../src/decide.ts";
import { jigCore } from "../src/index.ts";
import { NotConfiguredError } from "../src/kit/values.ts";
import { fakeContext, fakePi } from "./support/fake-pi.ts";
import type { FakePi } from "./support/fake-pi.ts";
import { tempState } from "./support/state.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const state = tempState();

/** One tool, as its plugin declared it, with everything its plugin documents. */
interface Audited {
    plugin: string;
    tool: string;
    actions: string[];
    declaration: ToolDeclaration;
    docs: string;
}

/** The loaded world: the plugins, and the session they were loaded into, closed at the end. */
interface World {
    host: FakePi;
    declared: ToolDeclaration[];
    close(): Promise<void>;
}

let world: World | undefined;

before(async () => {
    state.start();
    world = await startWorld();
});

after(async () => {
    await world?.close();
    world = undefined;
    state.stop();
});

/** The plugins in the order package.json loads them: jig-core first, then each other plugin, by its entry file. */
function extensions(): Array<{ plugin: string; file: string }> {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
        pi: { extensions: string[] };
    };
    return manifest.pi.extensions.map((entry) => ({
        plugin: /^\.\/plugins\/([^/]+)\//.exec(entry)?.[1] ?? entry,
        file: path.join(ROOT, entry),
    }));
}

/** The `jig.json` the audit runs with: generic names only, and every value one a validator accepts. */
function configFor(agentDir: string): unknown {
    const http = path.join(agentDir, "http");
    const kubernetes = (context: string) => ({
        kubernetes: { context, namespace: "orders", selector: "app=orders-api" },
    });
    const job = {
        system: "gitlab",
        url: "https://gitlab.example.com",
        project: "acme/orders-api",
        auth: { token: "pass:ci/token" },
    };
    return {
        environments: { staging: { kind: "test" } },
        mongo: {
            connections: {
                staging: {
                    uri: "mongodb://db.staging.example.com:27017",
                    user: "agent",
                    password: "pass:mongo/staging",
                },
                production: {
                    uri: "mongodb://db.example.com:27017",
                    user: "reader",
                    password: "pass:mongo/production",
                },
            },
            access: { production: { allow: { "orders.orders": ["_id", "status"] } } },
        },
        api: {
            collections: {
                orders: { http },
                postman: { postman: { cloud: "acme", apiKey: "pass:postman/key" } },
            },
            environments: { staging: "staging", production: "production" },
            adHoc: ["staging"],
        },
        ops: {
            services: {
                "orders-api": {
                    repo: "acme/orders-api",
                    ci: { system: "github-actions", workflow: "build.yml" },
                    environments: {
                        staging: {
                            deploy: { method: "helm", release: "orders-api", chart: "deploy/chart" },
                            runtime: kubernetes("staging"),
                            health: "https://api.staging.example.com/orders/health",
                            job,
                        },
                        production: {
                            runtime: kubernetes("production"),
                            health: "https://api.example.com/orders/health",
                            job,
                        },
                    },
                },
                "orders-api-live": {
                    repo: "acme/orders-api",
                    ci: { system: "github-actions", workflow: "build.yml", environment: "production" },
                    environments: {
                        staging: {
                            runtime: kubernetes("staging"),
                            health: "https://api.staging.example.com/orders/health",
                            job,
                        },
                        production: {
                            runtime: kubernetes("production"),
                            health: "https://api.example.com/orders/health",
                            job,
                        },
                    },
                },
            },
        },
    };
}

/** An api collection of two requests, whose hosts are variables of its environment file, as the source requires. */
function writeHttpCollection(agentDir: string): void {
    const http = path.join(agentDir, "http");
    mkdirSync(http);
    writeFileSync(
        path.join(http, "http-client.env.json"),
        JSON.stringify(
            {
                staging: { baseUrl: "https://api.staging.example.com" },
                production: { baseUrl: "https://api.example.com" },
            },
            null,
            4,
        ),
    );
    writeFileSync(
        path.join(http, "orders.http"),
        [
            "### Get health",
            "# @name Get health",
            "GET {{baseUrl}}/health",
            "",
            "### Create order",
            "# @name Create order",
            "POST {{baseUrl}}/orders",
            "Content-Type: application/json",
            "",
            '{"sku": "ABC"}',
            "",
        ].join("\n"),
    );
}

/** Loads every plugin into one stand-in for Pi, with a jig.json and a session started, as Pi does. */
async function startWorld(): Promise<World> {
    const agentDir = mkdtempSync(path.join(tmpdir(), "jig-audit-agent-"));
    writeHttpCollection(agentDir);
    writeFileSync(path.join(agentDir, "jig.json"), JSON.stringify(configFor(agentDir), null, 4));
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const host = fakePi();
    await jigCore()(host.pi);
    const api: JigApi = jig();
    const declared: ToolDeclaration[] = [];
    const declare = api.declareTool.bind(api);
    (api as { declareTool: typeof declare }).declareTool = (declaration) => {
        declared.push(declaration);
        declare(declaration);
    };
    for (const { file } of extensions().slice(1)) {
        const module = (await import(file)) as { default: ExtensionFactory };
        await module.default(host.pi);
    }
    const { ctx } = fakeContext({ cwd: ROOT });
    await host.fire("session_start", { reason: "startup" }, ctx);

    return {
        host,
        declared,
        async close() {
            await host.fire("session_shutdown", {}, ctx);
            withdrawJig(api);
            if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
            rmSync(agentDir, { recursive: true, force: true });
        },
    };
}

/** A plugin's README and every page under its docs, joined: its tables may be on either. */
function documented(plugin: string): string {
    const folder = path.join(ROOT, "plugins", plugin);
    const pages = [path.join(folder, "README.md")];
    const walk = (dir: string): void => {
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names) {
            const full = path.join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (name.endsWith(".md")) pages.push(full);
        }
    };
    walk(path.join(folder, "docs"));
    return pages.map((page) => readFileSync(page, "utf8")).join("\n");
}

/** The tools of the loaded world, each with the actions it offers and its plugin's documentation. */
function audit(): Audited[] {
    if (world === undefined) throw new Error("the audit world is not loaded");
    const audited: Audited[] = [];
    for (const declaration of world.declared) {
        const tool = world.host.registered.get(declaration.tool);
        if (tool === undefined) continue;
        const action = (tool.parameters as { properties?: Record<string, { enum?: string[] }> }).properties?.action;
        audited.push({
            plugin: declaration.plugin,
            tool: declaration.tool,
            actions: [...(action?.enum ?? [])],
            declaration,
            docs: documented(declaration.plugin),
        });
    }
    return audited;
}

/** The rows of every Markdown table in a page, each row as its cells. */
function tables(markdown: string): string[][] {
    return markdown
        .split("\n")
        .filter((line) => line.startsWith("|") && !line.startsWith("|---"))
        .map((line) =>
            line
                .split("|")
                .slice(1, -1)
                .map((cell) => cell.trim()),
        );
}

/** The names a cell lists, such as "`rebase`, `cherry_pick`": its backticked words. */
function namesOf(cell: string): string[] {
    return [...cell.matchAll(/`([a-z][a-z_-]*)`/g)].map((match) => match[1] ?? "");
}

/** The effect a cell names, when it names one: "read", "local write", "external write, asks", "read, or write". */
const EFFECT = /^(?:a |the )?(?:local |external )?(?:read|write)\b|^depends\b|^the strictest\b|^read, or write\b/i;

/** The effect cell of a row, which follows the cell naming the actions. */
function effectOf(cells: string[]): string | undefined {
    return cells.find((cell) => EFFECT.test(cell));
}

/**
 * The part of a plugin's documentation that is about one tool: the sections whose heading names it in backticks, such as
 * "### `deploy`". A plugin that documents several tools repeats an action name (`run` is a deploy write and a CI read), so
 * the whole page cannot be searched for one tool's rows. A tool with no such heading uses the whole page.
 */
function documentedFor(markdown: string, tool: string): string {
    const wanted = new RegExp(`\`${tool}\``);
    const sections: Array<{ heading: string; body: string[] }> = [];
    let current = { heading: "", body: [] as string[] };
    for (const line of markdown.split("\n")) {
        const heading = /^#{2,3}\s+(.+)$/.exec(line);
        if (heading !== null) {
            if (current.body.length > 0) sections.push(current);
            current = { heading: heading[1] ?? "", body: [] };
            continue;
        }
        current.body.push(line);
    }
    if (current.body.length > 0) sections.push(current);
    const named = sections.filter((section) => wanted.test(section.heading));
    return named.length === 0 ? markdown : named.map((section) => section.body.join("\n")).join("\n");
}

/**
 * The documentation row of every action of a tool, from every table in the part of the page about it. A row may name
 * several actions ("`tags`, `releases`"), its group cell may be empty on a continuation row, and its effect may be the
 * second cell or the third. A row that names an effect wins over one that does not, such as a table of the HTTP calls.
 */
function actionRows(markdown: string, tool: string, actions: readonly string[]): Map<string, string | undefined> {
    const rows = new Map<string, string | undefined>();
    for (const cells of tables(documentedFor(markdown, tool))) {
        const at = cells.findIndex((candidate) => namesOf(candidate).some((name) => actions.includes(name)));
        if (at === -1) continue;
        const effect = effectOf(cells.slice(at + 1));
        for (const name of namesOf(cells[at] ?? "")) {
            if (!actions.includes(name)) continue;
            if (rows.get(name) === undefined || effect !== undefined) rows.set(name, effect);
        }
    }
    return rows;
}

/** The text of every file under a plugin's tests. */
function testText(plugin: string): string {
    const found: string[] = [];
    const walk = (dir: string): void => {
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names) {
            const full = path.join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (name.endsWith(".ts")) found.push(readFileSync(full, "utf8"));
        }
    };
    walk(path.join(ROOT, "plugins", plugin, "test"));
    return found.join("\n");
}

/** The exact input one action takes: a tool refuses a field its action does not use. */
const ACTION_INPUTS: Record<string, Record<string, unknown>> = {
    "ticket save_evidence": { text: "a log line", label: "logs" },
    "ticket add_check": { text: "does the page load" },
    "ticket list_checks": {},
    "ticket close_check": { id: "1", outcome: "passed" },
    "ticket recall": { query: "OrderService" },
    "subagent start": { role: "scout", task: "look at the build" },
    "subagent status": {},
    "subagent message": { child: "scout-1", text: "hello" },
    "subagent stop": { child: "scout-1" },
    "workflow list": {},
    "workflow status": {},
    "workflow start": {},
    "workflow bind": { repo: "orders-api" },
    "workflow submit_plan": {},
    "workflow test": {},
    "workflow scenario": { number: 1, result: "passed" },
    "workflow advance": {},
    "workflow back": {},
    "mongo access": { environment: "staging" },
    "mongo databases": { environment: "staging" },
    "mongo collections": { environment: "staging", database: "orders" },
    "mongo schema": { environment: "staging", database: "orders", collection: "orders" },
    "mongo stats": { environment: "staging", database: "orders" },
    "mongo indexes": { environment: "staging", database: "orders", collection: "orders" },
    "mongo index_stats": { environment: "staging", database: "orders", collection: "orders" },
    "mongo explain": { environment: "staging", database: "orders", collection: "orders", filter: { status: "open" } },
    "mongo count": { environment: "staging", database: "orders", collection: "orders", filter: { status: "open" } },
    "mongo find": { environment: "staging", database: "orders", collection: "orders", filter: { status: "open" } },
    "mongo distinct": { environment: "staging", database: "orders", collection: "orders", field: "status" },
    "mongo sample": { environment: "staging", database: "orders", collection: "orders" },
    "mongo aggregate": {
        environment: "staging",
        database: "orders",
        collection: "orders",
        pipeline: [{ $match: { status: "open" } }],
    },
    "mongo insert": {
        environment: "staging",
        database: "orders",
        collection: "orders",
        documents: [{ status: "open" }],
    },
    "mongo update": {
        environment: "staging",
        database: "orders",
        collection: "orders",
        filter: { _id: "x" },
        which: "one",
        update: { $set: { status: "open" } },
    },
    "mongo replace": {
        environment: "staging",
        database: "orders",
        collection: "orders",
        filter: { _id: "x" },
        replacement: { status: "open" },
    },
    "mongo delete": {
        environment: "staging",
        database: "orders",
        collection: "orders",
        filter: { _id: "x" },
        which: "one",
    },
    "mongo bulk": {
        environment: "staging",
        database: "orders",
        collection: "orders",
        operations: [{ updateOne: { filter: { _id: "x" }, update: { $set: { status: "open" } } } }],
    },
    "mongo create_index": { environment: "staging", database: "orders", collection: "orders", keys: { status: 1 } },
    "mongo drop_index": { environment: "staging", database: "orders", collection: "orders", name: "status_1" },
    "api list": {},
    "api show": { request: "Get health" },
    "api run": { request: "Get health", environment: "staging" },
    "api run_folder": { folder: "orders.http", environment: "staging" },
    "api call": { environment: "staging", method: "GET", url: "https://api.staging.example.com/health" },
    "api postman_environments": {},
    "deploy plan": { service: "orders-api", environment: "staging", version: "1.4.0" },
    "deploy run": { service: "orders-api", environment: "staging", version: "1.4.0" },
    "deploy status": { service: "orders-api", environment: "staging" },
    "deploy rollback": { service: "orders-api", environment: "staging" },
    "deploy watch": { service: "orders-api", environment: "staging", version: "1.4.0", timeoutMinutes: 1 },
    "ci services": {},
    "ci status": { service: "orders-api", environment: "staging" },
    "ci runs": { service: "orders-api", environment: "staging" },
    "ci run": { service: "orders-api", environment: "staging", run_id: 1 },
    "ci log": { service: "orders-api", environment: "staging", run_id: 1 },
    "ci rerun": { service: "orders-api", environment: "staging", run_id: 1 },
    "ci trigger": { service: "orders-api", environment: "staging", ref: "main" },
    "ci watch": { service: "orders-api", environment: "staging", run_id: 1 },
    "runtime pods": { service: "orders-api", environment: "staging" },
    "runtime rollout": { service: "orders-api", environment: "staging" },
    "runtime logs": { service: "orders-api", environment: "staging", pod: "orders-api-1" },
    "runtime events": { service: "orders-api", environment: "staging" },
    "runtime health": { service: "orders-api", environment: "staging" },
};

/** A `TypeError` from `classify`: jig-core reads it as invalid input, and its message says why. */
interface Invalid {
    readonly invalid: string;
}

/** What `classify` says about one action, or why it said nothing. */
function classed(
    declaration: ToolDeclaration,
    action: string,
    input: Record<string, unknown>,
): CallClass | "unknown" | "unconfigured" | Invalid {
    try {
        const answer = declaration.classify({ action, ...input });
        return answer ?? "unknown";
    } catch (error) {
        if (error instanceof NotConfiguredError) return "unconfigured";
        if (error instanceof TypeError) return { invalid: error.message };
        throw error; // a real failure: a bug in classify
    }
}

/** True for the message a tool gives when it refuses a call because it is production, not for any other refusal. */
function refusesProduction(message: string): boolean {
    return (
        // mongo: a production write is refused before its own details are checked.
        /is production, which is read-only/.test(message) ||
        // deploy: run and rollback.
        /is production: the agent never changes production/.test(message) ||
        // api: an ad-hoc call.
        /is never allowed in production/.test(message)
    );
}

/** What one classification is, as the table records it. */
function described(answer: CallClass | "unknown" | "unconfigured" | Invalid): string {
    if (typeof answer === "string") return answer;
    if ("invalid" in answer) return "needs input";
    return `${answer.environment} ${answer.effect} ${answer.approval ?? "-"}`;
}

/** The production line of an action: the answer, or `refused` only when the refusal names production. */
function productionDescribed(answer: CallClass | "unknown" | "unconfigured" | Invalid): string {
    if (typeof answer === "object" && "invalid" in answer) {
        return refusesProduction(answer.invalid) ? "refused" : "needs input";
    }
    return described(answer);
}

/** True for a tool whose call names the environment, so the same action can be asked for production. */
const TWIN: ReadonlySet<string> = new Set(["mongo", "deploy", "ci", "runtime", "api"]);

/**
 * The production input of an action, or undefined when the call names no environment to change. Every action that
 * classifies in a named environment gets one, read or write: a production read must stay a read here, and a staging read
 * that turns into a production write shows too.
 */
function productionOf(tool: string, action: string, staging: CallClass): Record<string, unknown> | undefined {
    if (!TWIN.has(tool)) return undefined;
    if (staging.environment === "local" || staging.environment === "external") return undefined;
    const base = ACTION_INPUTS[`${tool} ${action}`] ?? {};
    return tool === "ci"
        ? { ...base, service: "orders-api-live", environment: "production" }
        : { ...base, environment: "production" };
}

describe("what a plugin's documentation says", () => {
    test("every action a tool offers is a row, and its effect and approval are what classify gives it", async () => {
        const failures: string[] = [];
        for (const { plugin, tool, actions, declaration, docs } of audit()) {
            if (actions.length === 0) continue;
            const rows = actionRows(docs, tool, actions);
            for (const action of actions) {
                if (!rows.has(action)) {
                    failures.push(`${plugin}: ${tool} ${action} is not a row of any table in its docs`);
                    continue;
                }
                const answer = classed(declaration, action, ACTION_INPUTS[`${tool} ${action}`] ?? {});
                if (typeof answer === "string" || "invalid" in answer) {
                    if (answer === "unconfigured")
                        failures.push(
                            `${plugin}: ${tool} ${action} cannot be classified: its section is not configured`,
                        );
                    continue;
                }
                const effect = (rows.get(action) ?? "").toLowerCase();
                // A row that says the effect depends on the request or the method names no single effect to compare.
                if (!effect.includes("depend") && !effect.includes("strictest") && !effect.includes(answer.effect)) {
                    failures.push(
                        `${plugin}: ${tool} ${action} is a ${answer.effect} in code, and the row says "${effect}"`,
                    );
                }
                if (answer.approval === "review" && effect.includes("dialog") && !effect.includes("review")) {
                    failures.push(`${plugin}: ${tool} ${action} asks on the review screen, and the row says "dialog"`);
                }
                if (answer.approval === "dialog" && effect.includes("review") && !effect.includes("dialog")) {
                    failures.push(`${plugin}: ${tool} ${action} asks on a dialog, and the row says "review"`);
                }
            }
        }
        assert.deepEqual(failures, []);
    });
});

describe("what a plugin's classify decides", () => {
    test("is the table this file records, staging and production, action by action", async () => {
        const found: Record<string, string> = {};
        for (const { tool, actions, declaration } of audit()) {
            for (const action of actions) {
                const staging = classed(declaration, action, ACTION_INPUTS[`${tool} ${action}`] ?? {});
                found[`${tool} ${action}`] = described(staging);
                if (typeof staging === "string" || "invalid" in staging) continue;
                const production = productionOf(tool, action, staging);
                if (production === undefined) continue;
                found[`${tool} ${action} production`] = productionDescribed(classed(declaration, action, production));
            }
        }
        assert.deepEqual(found, TABLE);
    });
});

describe("the floor, for a production line", () => {
    test("denies every production write, and allows every production read", async () => {
        const failures: string[] = [];
        for (const { tool, actions, declaration } of audit()) {
            for (const action of actions) {
                const staging = classed(declaration, action, ACTION_INPUTS[`${tool} ${action}`] ?? {});
                if (typeof staging === "string" || "invalid" in staging) continue;
                const production = productionOf(tool, action, staging);
                if (production === undefined) continue;
                const answer = classed(declaration, action, production);
                // A refusal in classify, for production or any other reason: the floor's rules are never reached.
                if (typeof answer === "string" || "invalid" in answer) continue;
                const verdict = decide({
                    call: {
                        tool,
                        action,
                        environment: answer.environment,
                        environmentKind: "production",
                        effect: answer.effect,
                        ...(answer.approval === undefined ? {} : { approval: answer.approval }),
                        unknown: false,
                    },
                    rules: [],
                    sessionAllows: new Set<string>(),
                    hasUI: true,
                });
                const wanted = answer.effect === "write" ? "deny" : "allow";
                if (verdict.decision !== wanted) {
                    failures.push(
                        `${tool} ${action} production: a ${answer.effect} should be ${wanted} and is ${verdict.decision}`,
                    );
                }
                if (answer.effect === "write" && verdict.floor !== "production-write") {
                    failures.push(
                        `${tool} ${action} production: denied by ${verdict.floor ?? "no floor"}, not the production rule`,
                    );
                }
            }
        }
        assert.deepEqual(failures, []);
    });
});

describe("what a plugin's tests name", () => {
    test("is reported, so an action no test names is seen rather than assumed", async () => {
        let actions = 0;
        const gaps: string[] = [];
        for (const { plugin, tool, actions: offered } of audit()) {
            if (offered.length === 0) continue;
            const text = testText(plugin);
            actions += offered.length;
            const untested = offered.filter((action) => !text.includes(`action: "${action}"`));
            if (untested.length > 0) gaps.push(`${plugin}: ${tool}: ${untested.join(", ")}`);
        }
        console.log(`audit: ${actions} actions; ${gaps.length === 0 ? "every one named by a test" : gaps.join("; ")}`);
    });
});

describe("a tool's own masking", () => {
    test("is a promise its tests can see: a tool that masks its own results is named as masking in them", async () => {
        const failures: string[] = [];
        for (const { plugin, tool, declaration } of audit()) {
            if (declaration.masksOwnResults !== true) continue;
            if (!testText(plugin).includes("mask"))
                failures.push(`${plugin}: ${tool} masks its own results, and no test says "mask"`);
        }
        assert.deepEqual(failures, []);
    });
});

/** The classification of every action of every tool, as they are today. A change here is deliberate. */
const TABLE: Record<string, string> = {
    "ticket save_evidence": "local write -",
    "ticket add_check": "local write -",
    "ticket list_checks": "local read -",
    "ticket close_check": "local write -",
    "ticket recall": "local read -",
    "workflow list": "local read -",
    "workflow status": "local read -",
    "workflow start": "local write -",
    "workflow bind": "local write -",
    "workflow submit_plan": "local write review",
    "workflow test": "local write -",
    "workflow scenario": "local write -",
    "workflow advance": "local write -",
    "workflow back": "local write -",
    "subagent start": "local write -",
    "subagent status": "local read -",
    "subagent message": "local write -",
    "subagent stop": "local write -",
    "git status": "local read -",
    "git diff": "local read -",
    "git log": "local read -",
    "git show": "local read -",
    "git blame": "local read -",
    "git branches": "local read -",
    "git fetch": "local read -",
    "git clone": "local write -",
    "git branch": "local write -",
    "git worktree": "local write -",
    "git commit": "local write -",
    "git stash": "local write -",
    "git sync": "local write -",
    "git merge": "local write -",
    "git rebase": "local write -",
    "git cherry_pick": "local write -",
    "git restore": "local write -",
    "git push": "external write -",
    "pr view": "external read -",
    "pr list": "external read -",
    "pr comments": "external read -",
    "pr create": "external write review",
    "pr edit": "external write review",
    "pr ready": "external write -",
    "pr comment": "external write review",
    "pr reply": "external write review",
    "pr resolve": "external write -",
    "pr review": "external write review",
    "pr merge": "external write -",
    "pr watch": "local write -",
    "release tags": "local read -",
    "release releases": "external read -",
    "release tag_create": "local write -",
    "release tag_push": "external write -",
    "release release_create": "external write -",
    "jira get": "external read -",
    "jira search": "external read -",
    "jira comments": "external read -",
    "jira transitions": "external read -",
    "jira changelog": "external read -",
    "jira attachments": "external read -",
    "jira assignable": "external read -",
    "jira find_field": "external read -",
    "jira link_types": "external read -",
    "jira create": "external write review",
    "jira comment": "external write review",
    "jira edit_comment": "external write review",
    "jira delete_comment": "external write dialog",
    "jira transition": "external write dialog",
    "jira update": "external write dialog",
    "jira link": "external write dialog",
    "jira unlink": "external write dialog",
    "api list": "local read -",
    "api show": "local read -",
    "api run": "staging read -",
    "api run production": "production read -",
    "api run_folder": "staging write -",
    "api run_folder production": "production write -",
    "api call": "staging read -",
    "api call production": "refused",
    "api postman_environments": "external read -",
    "runtime pods": "staging read -",
    "runtime pods production": "production read -",
    "runtime rollout": "staging read -",
    "runtime rollout production": "production read -",
    "runtime logs": "staging read -",
    "runtime logs production": "production read -",
    "runtime events": "staging read -",
    "runtime events production": "production read -",
    "runtime health": "staging read -",
    "runtime health production": "production read -",
    "deploy plan": "staging read -",
    "deploy plan production": "production read -",
    "deploy run": "staging write -",
    "deploy run production": "refused",
    "deploy status": "staging read -",
    "deploy status production": "production read -",
    "deploy rollback": "staging write -",
    "deploy rollback production": "refused",
    "deploy watch": "local write -",
    "ci services": "local read -",
    "ci status": "staging read -",
    "ci status production": "production read -",
    "ci runs": "staging read -",
    "ci runs production": "production read -",
    "ci run": "staging read -",
    "ci run production": "production read -",
    "ci log": "staging read -",
    "ci log production": "production read -",
    "ci rerun": "staging write -",
    "ci rerun production": "production write -",
    "ci trigger": "staging write -",
    "ci trigger production": "production write -",
    "ci watch": "local write -",
    "mongo access": "staging read -",
    "mongo access production": "production read -",
    "mongo databases": "staging read -",
    "mongo databases production": "production read -",
    "mongo collections": "staging read -",
    "mongo collections production": "production read -",
    "mongo schema": "staging read -",
    "mongo schema production": "production read -",
    "mongo stats": "staging read -",
    "mongo stats production": "production read -",
    "mongo indexes": "staging read -",
    "mongo indexes production": "production read -",
    "mongo index_stats": "staging read -",
    "mongo index_stats production": "production read -",
    "mongo explain": "staging read -",
    "mongo explain production": "production read -",
    "mongo count": "staging read -",
    "mongo count production": "production read -",
    "mongo find": "staging read -",
    "mongo find production": "production read -",
    "mongo distinct": "staging read -",
    "mongo distinct production": "production read -",
    "mongo sample": "staging read -",
    "mongo sample production": "production read -",
    "mongo aggregate": "staging read -",
    "mongo aggregate production": "production read -",
    "mongo insert": "staging write -",
    "mongo insert production": "production write -",
    "mongo update": "staging write -",
    "mongo update production": "production write -",
    "mongo replace": "staging write -",
    "mongo replace production": "production write -",
    "mongo delete": "staging write -",
    "mongo delete production": "production write -",
    "mongo bulk": "staging write -",
    "mongo bulk production": "production write -",
    "mongo create_index": "staging write -",
    "mongo create_index production": "production write -",
    "mongo drop_index": "staging write -",
    "mongo drop_index production": "production write -",
};
