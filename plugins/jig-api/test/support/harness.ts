// Everything a tool test needs: a fake API and a fake token endpoint on this machine, the fake jig-core, and the plugin loaded
// into a fake Pi the way Pi loads it. `call` then runs a tool call the way jig-core runs one: classify it, build the preview
// when the call asks (a write outside the machine), block it when the preview says the input is invalid, keep the approved
// preview, and execute.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CallClass, Preview, ToolDeclaration } from "../../../jig-core/src/contract.ts";
import { jigHttp } from "../../src/index.ts";
import { startFakeApi } from "./fake-api.ts";
import type { FakeApi } from "./fake-api.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";

/** The name of the default target. */
export const TARGET = "api";
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

export interface Harness {
    /** The fake API that the default target points to. */
    api: FakeApi;
    /** The fake OAuth token endpoint. */
    auth: FakeApi;
    /** The tokens the token endpoint issued, in order. */
    issued: string[];
    jig: FakeJig;
    clock: Clock;
    /** The tool Pi registered and the declaration jig-core holds. Both are made again by `reset`. */
    tool: ToolDefinition;
    declaration: ToolDeclaration;
    /** The default section: one target, `api`, in `staging`, with the given sign-in. */
    section(auth?: Record<string, unknown>, extra?: Record<string, unknown>): Record<string, unknown>;
    /** The `oauthPassword` settings that point at the fake token endpoint. */
    oauth(extra?: Record<string, unknown>): Record<string, unknown>;
    /** Sets the `http` section as jig.json holds it, and the secrets its references name. */
    configure(section?: Record<string, unknown>): void;
    /** Back to the fixtures, the default configuration, and no request or fact recorded. */
    reset(): void;
    /** `target` is `api` unless the input says otherwise. */
    call(input: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
    close(): Promise<void>;
}

export async function setupHarness(options: { timeoutScale?: number } = {}): Promise<Harness> {
    const api = await startFakeApi();
    const auth = await startFakeApi();
    const jig = installFakeJig();
    const clock: Clock = { now: 1_700_000_000_000 };
    const issued: string[] = [];

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
    function load(): { tool: ToolDefinition; declaration: ToolDeclaration } {
        jig.publish();
        const tools: ToolDefinition[] = [];
        const pi = { registerTool: (tool: ToolDefinition) => void tools.push(tool) } as unknown as ExtensionAPI;
        void jigHttp({ now: () => clock.now, ...(options.timeoutScale === undefined ? {} : { timeoutScale: options.timeoutScale }) })(pi);
        const tool = tools[0];
        const declaration = jig.declared.get("http");
        if (tool === undefined || declaration === undefined) throw new Error("the plugin did not register its tool");
        return { tool, declaration };
    }

    const section = (signIn: Record<string, unknown> = { none: true }, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        targets: { [TARGET]: { baseUrl: api.origin, environment: "staging", allowPlainLocal: true, auth: signIn, ...extra } },
    });
    const oauth = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        tokenUrl: `${auth.origin}/oauth/token`,
        clientId: "portal",
        clientSecret: CLIENT_SECRET_REFERENCE,
        username: USER_REFERENCE,
        password: PASSWORD_REFERENCE,
        ...extra,
    });
    const configure = (value: Record<string, unknown> = section()): void => {
        jig.setSection("http", value);
        jig.secrets.set(SECRET_REFERENCE, SECRET);
        jig.secrets.set(USER_REFERENCE, USER);
        jig.secrets.set(PASSWORD_REFERENCE, PASSWORD);
        jig.secrets.set(CLIENT_SECRET_REFERENCE, CLIENT_SECRET);
    };
    configure();
    let counter = 0;

    const harness: Harness = {
        api,
        auth,
        issued,
        jig,
        clock,
        ...load(),
        section,
        oauth,
        configure,
        reset() {
            api.reset();
            auth.reset();
            issued.length = 0;
            issueTokens();
            jig.reset();
            clock.now = 1_700_000_000_000;
            configure();
            Object.assign(harness, load());
        },
        async call(given, callOptions = {}) {
            jig.publish();
            const { tool, declaration } = harness;
            const input = { target: TARGET, ...given };
            const id = `call-${++counter}`;

            let cls: CallClass | undefined;
            try {
                cls = declaration.classify(input);
            } catch (error) {
                // What jig-core does when a declaration cannot classify a call: it blocks, and does not ask.
                const reason = error instanceof Error ? error.message : String(error);
                return { id, text: "", blocked: `jig-core could not decide: ${reason}` };
            }
            const asks = callOptions.ask ?? (cls === undefined || (cls.environment !== "local" && cls.effect === "write"));
            let preview: Preview | undefined;
            if (asks && declaration.preview !== undefined) {
                try {
                    preview = await declaration.preview(input, callOptions.signal ?? new AbortController().signal);
                } catch (error) {
                    // What jig-core does: the message is cut to one line of 200 characters; a TypeError blocks the call,
                    // anything else shows "preview unavailable" and the person can still decide.
                    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
                    if (error instanceof TypeError) return { id, text: "", blocked: `Blocked by jig-core: http cannot run with this input: ${reason}`, cls };
                    preview = { summary: `preview unavailable: ${reason}` };
                }
                jig.approved.set(id, preview);
            }
            await callOptions.between?.(input);
            const shown = preview === undefined ? {} : { preview };
            try {
                const result = await tool.execute(id, input as never, callOptions.signal, undefined, {} as ExtensionToolContext);
                const first = result.content[0];
                return { id, text: first !== undefined && first.type === "text" ? first.text : "", cls, ...shown, details: result.details };
            } catch (error) {
                return { id, text: "", error: error as Error, cls, ...shown };
            }
        },
        close: async () => {
            jig.remove();
            await Promise.all([api.close(), auth.close()]);
        },
    };
    return harness;
}

/** The text of a call that must have worked; a failure or a block fails the test with the message. */
export function ok(result: CallResult): string {
    if (result.blocked !== undefined) throw new Error(`expected the call to work, but it was blocked: ${result.blocked}`);
    if (result.error !== undefined) throw new Error(`expected the call to work, but it failed: ${result.error.message}`);
    return result.text;
}
