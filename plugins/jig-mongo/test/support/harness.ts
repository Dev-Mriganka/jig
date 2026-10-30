// Everything a tool test needs: the fake jig-core, a fake database behind the driver seam, and the plugin loaded into a fake Pi the
// way Pi loads it. `call` then runs a tool call the way jig-core runs one: classify it, build the preview when the call asks (a
// write to a test environment), block it when the classification or the preview says the input is invalid, keep the approved
// preview, and execute.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CallClass, Preview, ToolDeclaration } from "../../../jig-core/src/contract.ts";
import type { ConnectTarget } from "../../src/backend.ts";
import { jigMongo } from "../../src/index.ts";
import type { MongoOptions } from "../../src/index.ts";
import type { SessionDeps } from "../../src/session.ts";
import { fakeBackend } from "./fake-backend.ts";
import type { FakeBackend } from "./fake-backend.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";
import { defaultSection, PRODUCTION_PASSWORD, STAGING_PASSWORD } from "./section.ts";

export { defaultSection, PRODUCTION_PASSWORD, STAGING_PASSWORD };

export interface CallOptions {
    /** Force or forbid the ask. Default: ask for any write to a test environment, as the rules table does. */
    ask?: boolean;
    /** Runs after the preview was approved and before the tool runs: what changes while the person reads. */
    between?: () => void | Promise<void>;
    signal?: AbortSignal;
}

export interface CallResult {
    id: string;
    /** The text the model gets. Empty when the call failed or was blocked. */
    text: string;
    error?: Error;
    /** Set when jig-core would have blocked the call without running the tool, and why. */
    blocked?: string;
    cls?: CallClass;
    preview?: Preview;
    details?: Record<string, unknown>;
}

export interface Harness {
    jig: FakeJig;
    backend: FakeBackend;
    /** What the plugin asked the driver seam to connect to, in order. */
    connects: ConnectTarget[];
    tool: ToolDefinition;
    declaration: ToolDeclaration;
    /** The handlers the plugin registered on Pi's events. */
    handlers: Map<string, Array<() => unknown>>;
    /** Sets the `mongo` section as jig.json holds it, and the secrets the references name. */
    configure(section?: Record<string, unknown>): void;
    /** A new load of the plugin, as at a reload, with these options. */
    load(options?: MongoOptions): void;
    reset(): void;
    call(input: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
    close(): Promise<void>;
}

export function setupHarness(options: MongoOptions = {}): Harness {
    const jig = installFakeJig();
    const backend = fakeBackend();
    const connects: ConnectTarget[] = [];
    let counter = 0;

    const harness: Harness = {
        jig,
        backend,
        connects,
        tool: undefined as never,
        declaration: undefined as never,
        handlers: new Map(),
        configure(section = defaultSection()) {
            jig.setSection("mongo", section);
            jig.secrets.set(STAGING_PASSWORD.reference, STAGING_PASSWORD.value);
            jig.secrets.set(PRODUCTION_PASSWORD.reference, PRODUCTION_PASSWORD.value);
        },
        load(loadOptions = options) {
            jig.publish();
            const tools: ToolDefinition[] = [];
            harness.handlers.clear();
            const pi = {
                registerTool: (tool: ToolDefinition) => void tools.push(tool),
                on: (event: string, handler: () => unknown) =>
                    void harness.handlers.set(event, [...(harness.handlers.get(event) ?? []), handler]),
            } as unknown as ExtensionAPI;
            const connect = async (target: ConnectTarget) => {
                connects.push(target);
                return backend;
            };
            void jigMongo({ connect, ...loadOptions })(pi);
            const tool = tools[0];
            const declaration = jig.declared.get("mongo");
            if (tool === undefined || declaration === undefined)
                throw new Error("the plugin did not register its tool");
            harness.tool = tool;
            harness.declaration = declaration;
        },
        reset() {
            backend.reset();
            jig.reset();
            connects.length = 0;
            harness.configure();
            harness.load();
        },
        async call(input, callOptions = {}) {
            jig.publish();
            const id = `call-${++counter}`;
            let cls: CallClass | undefined;
            try {
                cls = harness.declaration.classify(input);
            } catch (error) {
                // What jig-core does when a declaration cannot classify a call: it blocks, and does not ask.
                return { id, text: "", blocked: error instanceof Error ? error.message : String(error) };
            }
            const kind = cls === undefined ? "external" : (jig.kinds.get(cls.environment) ?? "production");
            const asks = callOptions.ask ?? (cls === undefined || (cls.effect === "write" && kind !== "local"));
            let preview: Preview | undefined;
            if (asks && harness.declaration.preview !== undefined) {
                try {
                    preview = await harness.declaration.preview(
                        input,
                        callOptions.signal ?? new AbortController().signal,
                    );
                } catch (error) {
                    const reason = (error instanceof Error ? error.message : String(error))
                        .replace(/\s+/g, " ")
                        .slice(0, 200);
                    // What jig-core does: a TypeError blocks the call; anything else shows "preview unavailable" and the person decides.
                    if (error instanceof TypeError) return { id, text: "", blocked: reason, cls };
                    preview = { summary: `preview unavailable: ${reason}` };
                }
                jig.approved.set(id, preview);
            }
            await callOptions.between?.();
            const shown = preview === undefined ? {} : { preview };
            try {
                const result = await harness.tool.execute(
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
                    details: result.details as Record<string, unknown>,
                };
            } catch (error) {
                return { id, text: "", error: error as Error, cls, ...shown };
            }
        },
        async close() {
            for (const handler of harness.handlers.get("session_shutdown") ?? []) handler();
            jig.remove();
        },
    };
    harness.configure();
    harness.load();
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

export type { SessionDeps };
