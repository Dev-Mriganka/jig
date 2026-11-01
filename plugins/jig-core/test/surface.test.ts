// jig-core's public surface, pinned. A company plugin imports jig-core's contract and kit and reaches its API through a global handle, so
// those names are what Jig promises. Every expectation below is a LITERAL written in this file, never a value imported from the code
// under test: a rename or a removal fails here until a person changes the literal on purpose.
//
// Adding to the surface is fine: add the name to the list here, and to docs/compatibility.md. Removing or renaming something needs an
// entry in docs/decisions.md, and for the contract a new `version`. Never loosen a pin to get a build green: if a name has to go, say
// so in docs/decisions.md first (docs/compatibility.md).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { jig, withdrawJig, withJig } from "../src/client.ts";
import { OWN_SECTIONS } from "../src/config.ts";
import { jigCore } from "../src/index.ts";
import { callRecord, turnRecord } from "../src/records.ts";
import { fakePi } from "./support/fake-pi.ts";
import { tempState } from "./support/state.ts";

const CORE = path.resolve(import.meta.dirname, "../src");
const ROOT = path.resolve(import.meta.dirname, "../../..");
const state = tempState();
beforeEach(() => state.start());
afterEach(() => state.stop());

/** Every name a module exports, types included: `export const|function|class|interface|type|enum X`, and `export { A, B as C }`. */
function exportedNames(file: string): string[] {
    const text = readFileSync(file, "utf8");
    const names = new Set<string>();
    const declaration =
        /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([\w$]+)/gm;
    for (const match of text.matchAll(declaration)) names.add(match[1] as string);
    for (const match of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
        for (const part of (match[1] as string).split(",")) {
            const name = part
                .trim()
                .split(/\s+as\s+/)
                .pop()
                ?.trim();
            if (name) names.add(name);
        }
    }
    if (/^export\s+default\b/m.test(text)) names.add("default");
    if (/^export\s+\*/m.test(text)) names.add("*");
    return [...names].sort();
}

describe("the global handle", () => {
    test("jig-core publishes its API on the symbol jig.core.api/v1, and plugins that load first wait on jig.core.pending/v1", () => {
        const slot = globalThis as unknown as Record<symbol, unknown>;
        const queue = Symbol.for("jig.core.pending/v1");
        assert.equal(slot[queue], undefined);
        const early = (): void => {};
        withJig(early);
        assert.deepEqual(slot[queue], [early]);
        let seen: unknown;
        withJig((api) => {
            seen = api;
        });

        jigCore()(fakePi().pi);
        const api = jig();
        assert.equal(slot[Symbol.for("jig.core.api/v1")], api);
        assert.equal(seen, api, "a plugin that loaded first is called when jig-core publishes");
        assert.deepEqual(slot[queue], [], "and the queue is empty afterwards");

        withdrawJig(api);
        assert.equal(slot[Symbol.for("jig.core.api/v1")], undefined, "withdrawing removes it");
        assert.throws(() => jig(), /jig-core is not loaded/);
    });

    test("the contract version is 1", () => {
        jigCore()(fakePi().pi);
        const api = jig();
        assert.equal(api.version, 1);
        withdrawJig(api);
    });
});

describe("the API", () => {
    test("has exactly these members: a name with () is a function, a name without is a value, nested namespaces included", () => {
        jigCore()(fakePi().pi);
        const api = jig();
        const found: string[] = [];
        const walk = (value: object, prefix: string): void => {
            for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
                const name = `${prefix}${key}`;
                if (descriptor.get !== undefined) found.push(name);
                else if (typeof descriptor.value === "function") found.push(`${name}()`);
                else if (typeof descriptor.value === "object" && descriptor.value !== null)
                    walk(descriptor.value, `${name}.`);
                else found.push(name);
            }
        };
        walk(api, "");
        withdrawJig(api);
        assert.deepEqual(found.sort(), [
            "addFacts()",
            "approvals.inTurn()",
            "approvedPreview()",
            "config.addClassifyRules()",
            "config.addEnvironments()",
            "config.addMaskFields()",
            "config.addProtectedPaths()",
            "config.addRules()",
            "config.addSecretCommands()",
            "config.addSectionDefaults()",
            "config.enableSecretBackends()",
            "config.registerSection()",
            "config.section()",
            "declareTool()",
            "environments.kindOf()",
            "environments.list()",
            "exec.git()",
            "exec.run()",
            "gates.register()",
            "http.request()",
            "mask.text()",
            "mask.value()",
            "protectedPaths.list()",
            "sandbox.canRun",
            "sandbox.register()",
            "sandbox.run()",
            "secrets.resolve()",
            "setTicket()",
            "signIn.headers()",
            "signIn.register()",
            "status.register()",
            "tools.declared()",
            "transports.register()",
            "transports.request()",
            "tunnels.open()",
            "tunnels.register()",
            "version",
            "watches.list()",
            "watches.registerKind()",
            "watches.start()",
            "watches.stop()",
        ]);
    });

    test("the jig.json sections jig-core owns are these, and a plugin cannot take them", () => {
        assert.deepEqual([...OWN_SECTIONS].sort(), [
            "classify",
            "environments",
            "protectedPaths",
            "records",
            "rules",
            "secrets",
            "spill",
        ]);
    });

    test("the events on Pi's event bus are these", async () => {
        const { JIG_EVENTS } = await import("../src/contract.ts");
        assert.deepEqual({ ...JIG_EVENTS }, { decision: "jig:decision", watchDone: "jig:watch-done" });
    });
});

describe("what plugins import", () => {
    test("contract.ts exports these names, types included", () => {
        assert.deepEqual(exportedNames(path.join(CORE, "contract.ts")), [
            "ApprovalKind",
            "CallClass",
            "ClassifyRule",
            "Decision",
            "DecisionEvent",
            "Effect",
            "EnvironmentConfig",
            "EnvironmentInfo",
            "EnvironmentKind",
            "EnvironmentName",
            "Facts",
            "Gate",
            "GateCall",
            "GateVerdict",
            "HttpAuth",
            "HttpErrorInfo",
            "HttpMethod",
            "HttpOAuth",
            "HttpRequest",
            "HttpResponse",
            "HttpValue",
            "JIG_EVENTS",
            "JigApi",
            "OpenedTunnel",
            "PollOutcome",
            "Preview",
            "ProtectedPathInfo",
            "Rule",
            "RunOptions",
            "RunResult",
            "SandboxNetworkMode",
            "SandboxProvider",
            "SandboxRunOptions",
            "SandboxRunResult",
            "SignInRequest",
            "SignInService",
            "StartWatch",
            "ToolDeclaration",
            "Transport",
            "TransportRequest",
            "TransportResponse",
            "Tunnel",
            "TunnelKind",
            "TunnelProvider",
            "WatchDoneEvent",
            "WatchInfo",
            "WatchKind",
            "WatchResult",
            "WatchUpdate",
        ]);
    });

    test("client.ts exports these names", () => {
        assert.deepEqual(exportedNames(path.join(CORE, "client.ts")), ["jig", "publishJig", "withJig", "withdrawJig"]);
    });

    test("the kit is these modules, and each exports these names", () => {
        const kit = path.join(CORE, "kit");
        const modules = readdirSync(kit).sort();
        assert.deepEqual(modules, [
            "abort.ts",
            "http-error.ts",
            "http.ts",
            "oauth.ts",
            "ports.ts",
            "role-policy.ts",
            "text.ts",
            "values.ts",
        ]);
        const expected: Record<string, string[]> = {
            "abort.ts": ["untilAborted"],
            "http-error.ts": ["HttpError", "isHttpError"],
            "http.ts": [
                "DEFAULT_MAX_BYTES",
                "DEFAULT_TIMEOUT_MS",
                "HttpDeps",
                "HttpError",
                "MAX_MAX_BYTES",
                "MAX_TIMEOUT_MS",
                "REDACTED",
                "createHttp",
                "credentialsOf",
                "isHttpError",
            ],
            "oauth.ts": ["Login", "REPLACE_EARLY_MS", "Token", "Tokens", "createTokens"],
            "ports.ts": [
                "FreePortOptions",
                "PortWaitError",
                "WaitOptions",
                "freePort",
                "portAccepts",
                "socksAnswers",
                "waitForPort",
            ],
            "role-policy.ts": [
                "ACTION_NAME_PATTERN",
                "ActionMap",
                "PolicyReading",
                "ROLE_POLICY_VARIABLE",
                "RolePolicy",
                "TOOL_NAME_PATTERN",
                "checkRolePolicy",
                "readRolePolicy",
                "writeRolePolicy",
            ],
            "text.ts": ["printable", "stringOf"],
            "values.ts": ["InputError", "isObject"],
        };
        for (const module of modules) {
            assert.deepEqual(exportedNames(path.join(kit, module)), (expected[module] ?? []).sort(), module);
        }
    });

    test("what each public module exports at run time is among those names (so the scan above misses nothing)", async () => {
        const modules = [
            "client.ts",
            "contract.ts",
            ...readdirSync(path.join(CORE, "kit")).map((name) => `kit/${name}`),
        ];
        for (const module of modules) {
            const file = path.join(CORE, module);
            const named = exportedNames(file);
            for (const key of Object.keys(await import(file)))
                assert.ok(named.includes(key), `${module} exports ${key}`);
        }
    });
});

describe("the record line", () => {
    test("a call has exactly these fields, and a turn has these", () => {
        const env = { JIG_PARENT_SESSION: "parent", JIG_AGENT_ROLE: "scout", JIG_CONDITION: "trial" };
        const call = callRecord(
            {
                session: "s",
                ticket: "PROJ-1",
                tool: "git",
                action: "push",
                plugin: "jig-git",
                environment: "staging",
                environmentKind: "test",
                effect: "write",
                decision: "ask",
                decisionSource: "rule",
                approval: "dialog",
                answer: "allow",
                waitedMs: 1,
                outcome: "error",
                errorKind: "tool",
                error: "failed",
                durationMs: 2,
                toolCallId: "t1",
                parentToolCallId: "t0",
                spill: "file",
                facts: { rows: 1 },
            },
            new Date(0),
            env,
        );
        assert.deepEqual(Object.keys(call).sort(), [
            "action",
            "agentRole",
            "answer",
            "approval",
            "condition",
            "decision",
            "decisionSource",
            "durationMs",
            "effect",
            "environment",
            "environmentKind",
            "error",
            "errorKind",
            "facts",
            "id",
            "kind",
            "outcome",
            "parentSession",
            "parentToolCallId",
            "plugin",
            "session",
            "spill",
            "ticket",
            "time",
            "tool",
            "toolCallId",
            "waitedMs",
        ]);
        const turn = turnRecord(
            { session: "s", ticket: "PROJ-1", model: "m", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
            new Date(0),
            env,
        );
        assert.deepEqual(Object.keys(turn).sort(), [
            "agentRole",
            "cacheRead",
            "cacheWrite",
            "condition",
            "cost",
            "id",
            "input",
            "kind",
            "model",
            "output",
            "parentSession",
            "session",
            "ticket",
            "time",
        ]);
        assert.equal(call.kind, "call");
        assert.equal(turn.kind, "turn");
    });
});

describe("environment variables", () => {
    test("the JIG_ variables the plugins read or set are these", () => {
        // Not variables: JIG_EVENTS is an exported constant of contract.ts, and JIG_DOCTOR_PASSWORD is a marker that `/sandbox doctor`
        // plants in its own probe command.
        const notVariables = ["JIG_DOCTOR_PASSWORD", "JIG_EVENTS"];
        const found = new Set<string>();
        for (const group of ["plugins", "examples"]) {
            for (const entry of readdirSync(path.join(ROOT, group), { recursive: true })) {
                const file = String(entry);
                if (!/(^|\/)src\/.*\.ts$/.test(file)) continue;
                const text = readFileSync(path.join(ROOT, group, file), "utf8");
                for (const match of text.matchAll(/\bJIG_[A-Z][A-Z0-9_]*\b/g)) found.add(match[0]);
            }
        }
        assert.deepEqual([...found].filter((name) => !notVariables.includes(name)).sort(), [
            "JIG_AGENT_ROLE",
            "JIG_CONDITION",
            "JIG_LENS_DASHBOARDS",
            "JIG_LENS_INDEX",
            "JIG_PARENT_SESSION",
            "JIG_ROLE_POLICY",
            "JIG_STATE_DIR",
            "JIG_THEME_FOOTER",
        ]);
    });
});
