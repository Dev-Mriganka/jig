// Everything a tool test needs: a fake Jira, the fake jig-core, and the plugin loaded into a fake Pi the way Pi loads it.
// `call` then runs a tool call the way jig-core runs one: classify it, build the preview when the call asks (a write outside
// the machine), block it when the preview says the input is invalid, keep the approved preview, and execute.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CallClass, Preview, ToolDeclaration } from "../../../jig-core/src/contract.ts";
import { jigJira } from "../../src/index.ts";
import { startFakeJira } from "./fake-jira.ts";
import type { FakeJira, Flavor } from "./fake-jira.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";

/** The address in the configuration. It is https, as the configuration requires; the plugin's `fetch` reaches the fake. */
export const SITE = "https://jira.example.test";
/** For tests that make a reply late: short, so they do not wait long, but many times what a request on this machine takes. */
export const SHORT_TIMEOUTS = { normal: 400, search: 800 };
/** For every other test: long, so that a busy machine can never make a request time out. */
export const LONG_TIMEOUTS = { normal: 20_000, search: 30_000 };
export const TOKEN = "tok-4f9c2a71d3e8";
export const TOKEN_REFERENCE = "pass:jira/token";

export interface CallOptions {
    /** Force or forbid the ask. Default: ask as the rules table does, for any write outside the machine. */
    ask?: boolean;
    /** Runs after the preview was approved and before the tool runs: what changes while the user reads. */
    between?: () => void | Promise<void>;
    signal?: AbortSignal;
}

export interface CallResult {
    /** The tool call id, which the facts and the approved preview are kept under. */
    id: string;
    /** The text the model gets. Empty when the call failed or was blocked. */
    text: string;
    /** The error the tool threw, which Pi turns into a failed result. */
    error?: Error;
    /** Set when the preview found the input invalid: the call was blocked, nobody was asked, and the tool never ran. */
    blocked?: string;
    cls?: CallClass;
    /** The preview that was approved, when the call asked. */
    preview?: Preview;
    details?: unknown;
}

export interface Harness {
    jira: FakeJira;
    jig: FakeJig;
    /** The tool Pi registered and the declaration jig-core holds. Both are made again by `reset`. */
    tool: ToolDefinition;
    declaration: ToolDeclaration;
    /** Sets the `jira` section as jig.json holds it. With no argument: Jira Cloud, an email and a token reference. */
    configure(section?: Record<string, unknown>): void;
    /** Back to the fixtures, the default configuration, and no request or fact recorded. */
    reset(): void;
    call(input: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
    close(): Promise<void>;
}

/** The default section: the https address, and an email with a token reference. */
export const cloudSection = (): Record<string, unknown> => ({
    site: SITE,
    auth: { email: "jane@example.test", token: TOKEN_REFERENCE },
});

export async function setupHarness(flavor: Flavor = "cloud", timeouts = LONG_TIMEOUTS): Promise<Harness> {
    const jira = await startFakeJira(flavor);
    const jig = installFakeJig();
    // Requests for the https address go to the fake on this machine; everything else about them is real.
    const reach = ((input: string | URL | Request, init?: RequestInit) =>
        fetch(String(input).replace(SITE, jira.origin), init)) as typeof fetch;

    /** Loads the plugin into a fake Pi, as Pi does at start-up. A new load has learned nothing yet. */
    function load(): { tool: ToolDefinition; declaration: ToolDeclaration } {
        jig.publish();
        const tools: ToolDefinition[] = [];
        const pi = { registerTool: (tool: ToolDefinition) => void tools.push(tool) } as unknown as ExtensionAPI;
        void jigJira({ fetch: reach, timeouts })(pi);
        const tool = tools[0];
        const declaration = jig.declared.get("jira");
        if (tool === undefined || declaration === undefined) throw new Error("the plugin did not register its tool");
        return { tool, declaration };
    }

    const configure = (section: Record<string, unknown> = cloudSection()): void => {
        jig.setSection("jira", section);
        jig.secrets.set(TOKEN_REFERENCE, TOKEN);
    };
    configure();
    let counter = 0;

    const harness: Harness = {
        jira,
        jig,
        ...load(),
        configure,
        reset() {
            jira.reset();
            jig.reset();
            configure();
            Object.assign(harness, load());
        },
        async call(input, options = {}) {
            jig.publish();
            const { tool, declaration } = harness;
            const id = `call-${++counter}`;
            const cls = declaration.classify(input);
            const asks = options.ask ?? (cls === undefined || (cls.environment !== "local" && cls.effect === "write"));
            let preview: Preview | undefined;
            if (asks && declaration.preview !== undefined) {
                try {
                    preview = await declaration.preview(input, options.signal ?? new AbortController().signal);
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
                            blocked: `Blocked by jig-core: jira cannot run with this input: ${reason}`,
                            cls,
                        };
                    preview = { summary: `preview unavailable: ${reason}` };
                }
                jig.approved.set(id, preview);
            }
            await options.between?.();
            try {
                const result = await tool.execute(
                    id,
                    input as never,
                    options.signal,
                    undefined,
                    {} as ExtensionToolContext,
                );
                const first = result.content[0];
                return {
                    id,
                    text: first !== undefined && first.type === "text" ? first.text : "",
                    cls,
                    ...(preview === undefined ? {} : { preview }),
                    details: result.details,
                };
            } catch (error) {
                return { id, text: "", error: error as Error, cls, ...(preview === undefined ? {} : { preview }) };
            }
        },
        close: async () => {
            jig.remove();
            await jira.close();
        },
    };
    return harness;
}

/** The text of a call that must have worked; a failure or a block fails the test with the message. */
export function ok(result: CallResult): string {
    if (result.blocked !== undefined)
        throw new Error(`expected the call to work, but it was blocked: ${result.blocked}`);
    if (result.error !== undefined)
        throw new Error(`expected the call to work, but it failed: ${result.error.message}`);
    return result.text;
}
