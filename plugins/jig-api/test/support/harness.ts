// Everything a tool test needs: fake APIs and a fake token endpoint on this machine, the fake jig-core, and the plugin loaded
// into a fake Pi the way Pi loads it. `call` then runs a tool call the way jig-core runs one: classify it, build the preview
// when the call asks (a write outside the machine), block it when the classification or the preview says the input is
// invalid, keep the approved preview, and execute.
//
// Two ways to configure it. `section` builds a small collection of one request in a folder of its own (`base`, in the
// environment `Staging`), signed in the way a test asks, and is what the tests of the sending engine use together with the
// ad-hoc `call` action. `acmeSection` (see acme.ts) copies the fixture collections of an example company.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionToolContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CallClass, Preview, ToolDeclaration } from "../../../jig-core/src/contract.ts";
import { jigApi } from "../../src/index.ts";
import type { ApiOptions } from "../../src/tool.ts";
import { startFakeApi } from "./fake-api.ts";
import type { FakeApi } from "./fake-api.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";

/** The collection's name for its test environment, and the collection that `section` writes. */
export const ENVIRONMENT = "Staging";
export const COLLECTION = "base";
export const SECRET = "tok-4f9c2a71d3e8";
export const SECRET_REFERENCE = "pass:api/token";
export const USER = "svc-user@example.test";
export const USER_REFERENCE = "pass:api/user";
export const PASSWORD = "P@ss w&rd=1%-CANARY";
export const PASSWORD_REFERENCE = "pass:api/password";
export const CLIENT_SECRET = "client-secret-CANARY-77";
export const CLIENT_SECRET_REFERENCE = "pass:api/client-secret";

/** For tests that make a reply late: a second of `timeoutSec` lasts this long, many times what a request on this machine takes. */
export const SHORT = 0.4;

/** The clock the token cache reads. */
export interface Clock {
    now: number;
}

export interface CallOptions {
    /** Force or forbid the ask. Default: ask as the rules table does, for any write outside the machine. */
    ask?: boolean;
    /** Runs after the preview was approved and before the tool runs: what changes while the user reads. It gets the input
     *  the tool will run with, which a later hook could change. */
    between?: (input: Record<string, unknown>) => void | Promise<void>;
    signal?: AbortSignal;
}

export interface CallResult {
    /** The tool call id, which the facts and the approved preview are kept under. */
    id: string;
    /** The text the model gets. Empty when the call failed or was blocked. */
    text: string;
    /** The error the tool threw, which Pi turns into a failed result. */
    error?: Error;
    /** Set when jig-core would have blocked the call without running the tool, and why. */
    blocked?: string;
    cls?: CallClass;
    /** The preview that was approved, when the call asked. */
    preview?: Preview;
    details?: unknown;
}

export type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** What a slash command said to the person, in order. */
export interface Notice {
    text: string;
    level: string;
}

export interface Harness {
    /** The fake API that the test environment points to. */
    api: FakeApi;
    /** A second fake API, for production. */
    prod: FakeApi;
    /** The fake OAuth token endpoint. */
    auth: FakeApi;
    /** The tokens the token endpoint issued, in order. */
    issued: string[];
    jig: FakeJig;
    clock: Clock;
    /** A folder for this test's files; it is emptied by `reset`. */
    dir: string;
    /** The tool Pi registered and the declaration jig-core holds. Both are made again by `reset`. */
    tool: ToolDefinition;
    declaration: ToolDeclaration;
    /** The slash commands Pi registered, by name. */
    commands: Map<string, CommandHandler>;
    /** The options the plugin was loaded with; a test may set `postmanApi` to point the cloud fetch at a fake server. */
    options: ApiOptions;
    /** Types a slash command, as the person would, and returns what it told them. */
    command(line: string): Promise<Notice[]>;
    /** An `api` section of one collection, `base`, in the environment `Staging` (jig-core's `staging`), signed in as asked:
     *  `{ none: true }`, `{ bearer: ref }`, `{ oauthPassword: ... }`, `{ signIn: name }` or `{ transport: name }`. Its files
     *  are written to `dir`. `extra.environment` names the jig-core environment instead. */
    section(signIn?: Record<string, unknown>, extra?: Record<string, unknown>): Record<string, unknown>;
    /** The OAuth settings that point at the fake token endpoint. */
    oauth(extra?: Record<string, unknown>): Record<string, unknown>;
    /** Sets the `api` section as jig.json holds it, and the secrets that the references of these tests name. */
    configure(section?: Record<string, unknown>): void;
    /** Back to the defaults: no request or fact recorded, the default configuration. */
    reset(): void;
    /** The tool input that `call` makes of a shorter ad-hoc form, for a test that asks the declaration directly. */
    input(given: Record<string, unknown>): Record<string, unknown>;
    /** A tool call. An input without an `action` is an ad-hoc call to the test API: `{ method, path, body?, headers?,
     *  timeoutSec? }`, or to another address of the environment with `origin`. */
    call(input: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
    close(): Promise<void>;
}

export async function setupHarness(options: { timeoutScale?: number } = {}): Promise<Harness> {
    const api = await startFakeApi();
    const prod = await startFakeApi();
    const auth = await startFakeApi();
    const jig = installFakeJig();
    const clock: Clock = { now: 1_700_000_000_000 };
    // The token cache of jig-core's request logic reads the same clock as the plugin.
    jig.setNow(() => clock.now);
    const issued: string[] = [];
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-api-test-"));

    /** A token endpoint that issues a new token for every request. */
    const issueTokens = (): void => {
        auth.respond = () => {
            const token = `TOKEN-CANARY-${issued.length + 1}-9f3a`;
            issued.push(token);
            return { body: JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 3600 }) };
        };
    };
    issueTokens();

    /** Loads the plugin into a fake Pi, as Pi does at start-up. A new load has learned nothing yet. */
    const apiOptions: ApiOptions = {
        now: () => clock.now,
        ...(options.timeoutScale === undefined ? {} : { timeoutScale: options.timeoutScale }),
    };
    function load(): { tool: ToolDefinition; declaration: ToolDeclaration; commands: Harness["commands"] } {
        jig.publish();
        const tools: ToolDefinition[] = [];
        const commands: Harness["commands"] = new Map();
        const pi = {
            registerTool: (tool: ToolDefinition) => void tools.push(tool),
            registerCommand: (name: string, command: { handler: CommandHandler }) =>
                void commands.set(name, command.handler),
        } as unknown as ExtensionAPI;
        void jigApi(apiOptions)(pi);
        const tool = tools[0];
        const declaration = jig.declared.get("api");
        if (tool === undefined || declaration === undefined) throw new Error("the plugin did not register its tool");
        return { tool, declaration, commands };
    }

    const oauth = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        tokenUrl: `${auth.origin}/oauth/token`,
        clientId: "portal",
        clientSecret: CLIENT_SECRET_REFERENCE,
        username: USER_REFERENCE,
        password: PASSWORD_REFERENCE,
        ...extra,
    });

    const section = (
        signIn: Record<string, unknown> = { none: true },
        extra: Record<string, unknown> = {},
    ): Record<string, unknown> => {
        const baseUrl = typeof extra.baseUrl === "string" ? extra.baseUrl : api.origin;
        const values: Array<Record<string, unknown>> = [
            { key: "baseUrl", value: baseUrl, type: "default", enabled: true },
        ];
        const secrets: Record<string, string> = {};
        const secretValue = (key: string): void => void values.push({ key, value: "", type: "secret", enabled: true });
        let auth_: Record<string, unknown> = { type: "noauth" };
        let mapping: string | Record<string, unknown> =
            typeof extra.environment === "string" ? extra.environment : "staging";

        if (typeof signIn.bearer === "string") {
            auth_ = { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] };
            secretValue("token");
            secrets.token = signIn.bearer;
        } else if (isRecord(signIn.oauthPassword)) {
            const settings = signIn.oauthPassword;
            const token = new URL(String(settings.tokenUrl));
            values.push({ key: "authUrl", value: token.origin, type: "default", enabled: true });
            values.push({ key: "clientId", value: String(settings.clientId), type: "default", enabled: true });
            const attributes: Array<Record<string, string>> = [
                { key: "grant_type", value: "password_credentials" },
                { key: "accessTokenUrl", value: `{{authUrl}}${token.pathname}${token.search}` },
                { key: "clientId", value: "{{clientId}}" },
                { key: "username", value: "{{username}}" },
                { key: "password", value: "{{password}}" },
            ];
            if (typeof settings.scope === "string") attributes.push({ key: "scope", value: settings.scope });
            for (const [name, reference] of [
                ["username", settings.username],
                ["password", settings.password],
                ["clientSecret", settings.clientSecret],
            ] as const) {
                if (typeof reference === "string") {
                    secretValue(name);
                    secrets[name] = reference;
                }
            }
            if (typeof settings.clientSecret === "string")
                attributes.push({ key: "clientSecret", value: "{{clientSecret}}" });
            auth_ = { type: "oauth2", oauth2: attributes };
        } else if (typeof signIn.signIn === "string") {
            mapping = {
                environment: typeof extra.environment === "string" ? extra.environment : "staging",
                signIn: signIn.signIn,
            };
        } else if (typeof signIn.transport === "string") {
            mapping = {
                environment: typeof extra.environment === "string" ? extra.environment : "staging",
                transport: signIn.transport,
            };
        }

        const collection = {
            info: { name: "Base", schema: "https://schema.postman.com/json/collection/v2.1.0/collection.json" },
            auth: auth_,
            item: [{ name: "Ping", request: { method: "GET", url: { raw: "{{baseUrl}}/ping" } } }],
        };
        const collectionFile = path.join(dir, "base.postman_collection.json");
        const environmentFile = path.join(dir, "base-staging.postman_environment.json");
        fs.writeFileSync(collectionFile, JSON.stringify(collection));
        fs.writeFileSync(environmentFile, JSON.stringify({ name: "Staging", values }));
        const adHoc = Array.isArray(extra.adHoc)
            ? extra.adHoc
            : [typeof extra.environment === "string" ? extra.environment : "staging"];
        return {
            collections: {
                [COLLECTION]: { postman: collectionFile, environments: { [ENVIRONMENT]: environmentFile } },
            },
            environments: { [ENVIRONMENT]: mapping },
            secrets,
            adHoc,
            allowPlainLocal: true,
            ...(Array.isArray(extra.reads) ? { reads: extra.reads } : {}),
        };
    };

    const configure = (value?: Record<string, unknown>): void => {
        jig.setSection("api", value ?? section());
        jig.secrets.set(SECRET_REFERENCE, SECRET);
        jig.secrets.set(USER_REFERENCE, USER);
        jig.secrets.set(PASSWORD_REFERENCE, PASSWORD);
        jig.secrets.set(CLIENT_SECRET_REFERENCE, CLIENT_SECRET);
    };
    configure();
    let counter = 0;

    /** The input of an ad-hoc call to the test API, from the shorter form most tests use. */
    const adHoc = (given: Record<string, unknown>): Record<string, unknown> => {
        const { path: target, origin, ...rest } = given;
        return {
            action: "call",
            environment: ENVIRONMENT,
            collection: COLLECTION,
            url: `${typeof origin === "string" ? origin : api.origin}${String(target)}`,
            ...rest,
        };
    };

    const harness: Harness = {
        api,
        prod,
        auth,
        issued,
        jig,
        clock,
        get dir() {
            return dir;
        },
        ...load(),
        section,
        oauth,
        configure,
        options: apiOptions,
        async command(line) {
            jig.publish();
            const [name, ...rest] = line.replace(/^\//, "").split(" ");
            const handler = harness.commands.get(name ?? "");
            if (handler === undefined) throw new Error(`the plugin registered no command named ${name}`);
            const notices: Notice[] = [];
            const context = {
                ui: { notify: (text: string, level = "info") => void notices.push({ text, level }) },
                signal: undefined,
            } as unknown as ExtensionCommandContext;
            await handler(rest.join(" "), context);
            return notices;
        },
        input: (given) => (given.action === undefined ? adHoc(given) : given),
        reset() {
            api.reset();
            prod.reset();
            auth.reset();
            issued.length = 0;
            issueTokens();
            jig.reset();
            jig.setNow(() => clock.now);
            fs.rmSync(dir, { recursive: true, force: true });
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-api-test-"));
            clock.now = 1_700_000_000_000;
            configure();
            Object.assign(harness, load());
        },
        async call(given, callOptions = {}) {
            jig.publish();
            const { tool, declaration } = harness;
            const input = harness.input(given);
            const id = `call-${++counter}`;

            let cls: CallClass | undefined;
            try {
                cls = declaration.classify(input);
            } catch (error) {
                // What jig-core does when a declaration cannot classify a call: it blocks, and does not ask.
                const reason = error instanceof Error ? error.message : String(error);
                return { id, text: "", blocked: `jig-core could not decide: ${reason}` };
            }
            const asks =
                callOptions.ask ?? (cls === undefined || (cls.environment !== "local" && cls.effect === "write"));
            let preview: Preview | undefined;
            if (asks && declaration.preview !== undefined) {
                try {
                    preview = await declaration.preview(input, callOptions.signal ?? new AbortController().signal);
                } catch (error) {
                    // What jig-core does: the message is cut to one line of 200 characters; a TypeError blocks the call,
                    // anything else shows "preview unavailable" and the person can still decide.
                    const reason = (error instanceof Error ? error.message : String(error))
                        .replace(/\s+/g, " ")
                        .slice(0, 200);
                    if (error instanceof TypeError)
                        return {
                            id,
                            text: "",
                            blocked: `Blocked by jig-core: api cannot run with this input: ${reason}`,
                            cls,
                        };
                    preview = { summary: `preview unavailable: ${reason}` };
                }
                jig.approved.set(id, preview);
            }
            await callOptions.between?.(input);
            const shown = preview === undefined ? {} : { preview };
            try {
                const result = await tool.execute(
                    id,
                    input as never,
                    callOptions.signal,
                    undefined,
                    {} as ExtensionToolContext,
                );
                const first = result.content[0];
                return {
                    id,
                    text: first !== undefined && first.type === "text" ? first.text : "",
                    cls,
                    ...shown,
                    details: result.details,
                };
            } catch (error) {
                return { id, text: "", error: error as Error, cls, ...shown };
            }
        },
        close: async () => {
            jig.remove();
            fs.rmSync(dir, { recursive: true, force: true });
            await Promise.all([api.close(), prod.close(), auth.close()]);
        },
    };
    return harness;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text of a call that must have worked; a failure or a block fails the test with the message. */
export function ok(result: CallResult): string {
    if (result.blocked !== undefined)
        throw new Error(`expected the call to work, but it was blocked: ${result.blocked}`);
    if (result.error !== undefined)
        throw new Error(`expected the call to work, but it failed: ${result.error.message}`);
    return result.text;
}
