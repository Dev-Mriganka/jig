// Everything a tool test needs: the fake jig-core, the fake kubectl and helm, a fake Pi, and the plugin loaded into it the
// way Pi loads it. `call` then runs a tool call the way jig-core runs one: classify it, block it when the tool says the input
// is invalid, decide by the default rules table, build the preview and record it as approved when the call would ask, and
// only then execute.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CallClass, Preview, ToolDeclaration } from "../../../jig-core/src/contract.ts";
import { jigOps } from "../../src/index.ts";
import type { OpsOptions } from "../../src/index.ts";
import { fakeClock } from "./clock.ts";
import type { FakeClock } from "./clock.ts";
import { installFakeGh } from "./fake-gh.ts";
import type { FakeGh } from "./fake-gh.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";
import { installFakePrograms } from "./fake-programs.ts";
import type { FakePrograms } from "./fake-programs.ts";
import { section } from "./section.ts";
import type { Raw } from "./section.ts";

export interface CallOptions {
    signal?: AbortSignal;
    /** The progress notes of the call are collected here. */
    updates?: string[];
    /** Do not ask, as if a rule allowed the call: the tool is given no approved preview. */
    allowed?: boolean;
    /** Runs after the user approved the preview and before the tool executes: the place to change the world. */
    between?: () => void | Promise<void>;
}

export interface CallResult {
    /** The tool call id. */
    id: string;
    /** The text the model gets. Empty when the call failed or was blocked. */
    text: string;
    /** The error the tool threw, which Pi turns into a failed result. */
    error?: Error;
    /** Set when jig-core would have blocked the call without running the tool, and what the model reads then. */
    blocked?: string;
    cls?: CallClass;
    /** The preview the user was shown, when the call asked. */
    preview?: Preview;
    details?: unknown;
}

export interface ToolHarness {
    tool: ToolDefinition;
    declaration: ToolDeclaration;
    call(input: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
}

/** Pi's event bus, as far as the plugin uses it: it listens, and it publishes. A test publishes as another plugin would. */
export interface FakeBus {
    /** What the plugin published, in order. */
    emitted: Array<{ event: string; payload: unknown }>;
    /** The channels the plugin listens to. */
    listening: string[];
    /** Publishes on a channel, as jig-git does: every listener gets the payload. */
    publish(event: string, payload: unknown): void;
}

export interface Harness {
    cluster: FakePrograms;
    /** The fake `gh` the GitHub Actions adapter starts. */
    gh: FakeGh;
    jig: FakeJig;
    clock: FakeClock;
    bus: FakeBus;
    runtime: ToolHarness;
    deploy: ToolHarness;
    ci: ToolHarness;
    /** Sets the `ops` section as jig.json holds it. */
    configure(raw?: Raw): void;
    close(): void;
}

/** What jig-core's default rules table does with a call: a read is allowed, a write to a test environment asks, a write to
 *  this machine is allowed, and a write to production is denied by the floor. */
function decide(cls: CallClass, kind: string): "allow" | "ask" | "deny" {
    if (cls.effect === "read" || kind === "local") return "allow";
    return kind === "production" ? "deny" : "ask";
}

/** What health checks use unless a test gives another: a test never reaches the network. */
const NO_NETWORK = async (): Promise<Response> => {
    throw new Error("a test tried to use the network: give the harness a fetch");
};

export function setupHarness(options: OpsOptions = {}): Harness {
    const jig = installFakeJig();
    const cluster = installFakePrograms();
    const gh = installFakeGh();
    jig.useProgramsIn([cluster.bin, gh.bin], cluster.env);
    const clock = fakeClock();

    // A Pi that keeps what the plugin registers, and an event bus.
    const tools = new Map<string, ToolDefinition>();
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    const bus: FakeBus = {
        emitted: [],
        listening: [],
        publish: (event, payload) => {
            listeners.get(event)?.forEach((listener) => {
                listener(payload);
            });
        },
    };
    const pi = {
        registerTool: (tool: ToolDefinition) => void tools.set(tool.name, tool),
        events: {
            on(channel: string, handler: (payload: unknown) => void) {
                bus.listening.push(channel);
                listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
                return () => {};
            },
            emit: (channel: string, payload: unknown) => void bus.emitted.push({ event: channel, payload }),
        },
    };

    // The network of a CI request is the fake jig's; health checks take theirs from the plugin's options.
    jig.setFetch(options.fetch ?? NO_NETWORK);
    jigOps({ now: clock.now, sleep: clock.deps.sleep, fetch: NO_NETWORK, ...options })(pi as unknown as ExtensionAPI);

    const configure = (raw: Raw = section()): void => jig.setSection("ops", raw);
    configure();
    let counter = 0;

    function harnessOf(name: string): ToolHarness {
        const tool = tools.get(name);
        const declaration = jig.declared.get(name);
        if (tool === undefined || declaration === undefined)
            throw new Error(`the plugin did not register the ${name} tool`);
        return {
            tool,
            declaration,
            async call(given, callOptions = {}) {
                jig.publish();
                const id = `call-${++counter}`;
                const blockedBy = (error: unknown): CallResult => {
                    // What jig-core does when a tool says its input is invalid: it blocks, and nobody is asked.
                    const reason = error instanceof Error ? error.message : String(error);
                    if (error instanceof TypeError)
                        return {
                            id,
                            text: "",
                            blocked: `Blocked by jig-core: ${name} cannot run with this input: ${reason}`,
                        };
                    return { id, text: "", blocked: `jig-core could not decide: ${reason}` };
                };

                let cls: CallClass | undefined;
                try {
                    cls = declaration.classify(given);
                } catch (error) {
                    return blockedBy(error);
                }
                // A tool that does not classify a call leaves it unknown, and an unknown call asks. These tools always classify.
                if (cls === undefined) return { id, text: "", blocked: "the tool did not classify the call" };

                const decision = decide(cls, jig.api.environments.kindOf(cls.environment));
                if (decision === "deny")
                    return { id, text: "", cls, blocked: "Denied by the floor: a write to production" };

                let preview: Preview | undefined;
                if (decision === "ask" && callOptions.allowed !== true && declaration.preview !== undefined) {
                    try {
                        preview = await declaration.preview(given, callOptions.signal ?? new AbortController().signal);
                        jig.approve(id, preview);
                    } catch (error) {
                        if (error instanceof TypeError) return blockedBy(error);
                        // "Preview unavailable": the user is still asked, and nothing is recorded as approved.
                    }
                }
                await callOptions.between?.();

                const onUpdate = (partial: { content: Array<{ type: string; text?: string }> }) => {
                    callOptions.updates?.push(partial.content[0]?.text ?? "");
                };
                try {
                    const result = await tool.execute(
                        id,
                        given as never,
                        callOptions.signal,
                        onUpdate as never,
                        {} as ExtensionToolContext,
                    );
                    const first = result.content[0];
                    return {
                        id,
                        text: first !== undefined && first.type === "text" ? first.text : "",
                        cls,
                        preview,
                        details: result.details,
                    };
                } catch (error) {
                    return { id, text: "", error: error as Error, cls, preview };
                }
            },
        };
    }

    return {
        cluster,
        gh,
        jig,
        clock,
        bus,
        runtime: harnessOf("runtime"),
        deploy: harnessOf("deploy"),
        ci: harnessOf("ci"),
        configure,
        close() {
            jig.remove();
            cluster.remove();
            gh.remove();
        },
    };
}

/** The text of a call that must have worked; a failure or a block fails the test with the message. */
export function ok(result: CallResult): string {
    if (result.blocked !== undefined)
        throw new Error(`expected the call to work, but it was blocked: ${result.blocked}`);
    if (result.error !== undefined)
        throw new Error(`expected the call to work, but it failed: ${result.error.message}`);
    return result.text;
}
