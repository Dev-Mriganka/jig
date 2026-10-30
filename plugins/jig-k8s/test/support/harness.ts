// Everything a tool test needs: the fake jig-core, the fake kubectl, a fake Pi with an event bus, and the plugin loaded into
// it the way Pi loads it. `call` then runs a tool call the way jig-core runs one: classify it, block it when the tool says
// the input is invalid, decide, announce the decision on the event bus, and only then execute.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CallClass, EnvironmentKind, ToolDeclaration } from "../../../jig-core/src/contract.ts";
import { jigK8s } from "../../src/index.ts";
import { fakeClock } from "./clock.ts";
import type { FakeClock } from "./clock.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";
import { installFakeKubectl } from "./fake-kubectl.ts";
import type { FakeKubectl } from "./fake-kubectl.ts";
import { section } from "./section.ts";
import type { Raw } from "./section.ts";

/** What jig-core's configuration says each environment is. A name it does not know counts as production. */
export const KINDS: Readonly<Record<string, EnvironmentKind>> = {
    local: "local",
    external: "external",
    production: "production",
    staging: "test",
    qa: "test",
    prod: "production",
};

export interface CallOptions {
    signal?: AbortSignal;
    /** Skip announcing jig-core's decision, as if jig-core never said anything about the call. */
    silent?: boolean;
    /** The kinds of environments for this call, over the default ones. */
    kinds?: Record<string, EnvironmentKind>;
    /** The progress notes of the call are collected here. */
    updates?: string[];
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
    details?: unknown;
}

export interface Harness {
    kubectl: FakeKubectl;
    jig: FakeJig;
    clock: FakeClock;
    tool: ToolDefinition;
    declaration: ToolDeclaration;
    /** Every message sent on the event bus. */
    emitted: Array<{ channel: string; data: unknown }>;
    /** Sets the `k8s` section as jig.json holds it. */
    configure(raw?: Raw): void;
    /** Sends a message on the event bus, as jig-core does. */
    emit(channel: string, data: unknown): void;
    call(input: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
    close(): void;
}

export function setupHarness(): Harness {
    const jig = installFakeJig();
    const kubectl = installFakeKubectl();
    jig.useProgramsIn(kubectl.bin, kubectl.env);
    const clock = fakeClock();

    // A Pi that keeps what the plugin registers, and runs listeners at once, as Pi's event bus does.
    const tools: ToolDefinition[] = [];
    const listeners = new Map<string, Array<(data: unknown) => void>>();
    const emitted: Harness["emitted"] = [];
    const pi = {
        registerTool: (tool: ToolDefinition) => void tools.push(tool),
        events: {
            on(channel: string, handler: (data: unknown) => void) {
                listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
                return () => {};
            },
            emit(channel: string, data: unknown) {
                emitted.push({ channel, data });
                for (const handler of listeners.get(channel) ?? []) handler(data);
            },
        },
    };

    jigK8s({ now: clock.now, sleep: clock.deps.sleep })(pi as unknown as ExtensionAPI);
    const tool = tools[0];
    const declaration = jig.declared.get("k8s");
    if (tool === undefined || declaration === undefined) throw new Error("the plugin did not register its tool");

    const configure = (raw: Raw = section()): void => jig.setSection("k8s", raw);
    configure();
    let counter = 0;

    return {
        kubectl,
        jig,
        clock,
        tool,
        declaration,
        emitted,
        configure,
        emit: (channel, data) => pi.events.emit(channel, data),
        async call(given, options = {}) {
            jig.publish();
            const id = `call-${++counter}`;
            let cls: CallClass | undefined;
            try {
                cls = declaration.classify(given);
            } catch (error) {
                // What jig-core does when a tool says its input is invalid: it blocks, and nobody is asked.
                const reason = error instanceof Error ? error.message : String(error);
                if (error instanceof TypeError) return { id, text: "", blocked: `Blocked by jig-core: k8s cannot run with this input: ${reason}` };
                return { id, text: "", blocked: `jig-core could not decide: ${reason}` };
            }
            // A tool that does not classify a call leaves it unknown, and an unknown call asks. This tool always classifies.
            if (cls === undefined) return { id, text: "", blocked: "the tool did not classify the call" };
            if (options.silent !== true) {
                const kind = options.kinds?.[cls.environment] ?? KINDS[cls.environment] ?? "production";
                pi.events.emit("jig:decision", {
                    toolCallId: id,
                    tool: "k8s",
                    action: cls.action,
                    environment: cls.environment,
                    environmentKind: kind,
                    effect: cls.effect,
                    decision: "allow",
                    source: "table",
                });
            }
            const onUpdate = (partial: { content: Array<{ type: string; text?: string }> }) => {
                options.updates?.push(partial.content[0]?.text ?? "");
            };
            try {
                const result = await tool.execute(id, given as never, options.signal, onUpdate as never, {} as ExtensionToolContext);
                const first = result.content[0];
                return { id, text: first !== undefined && first.type === "text" ? first.text : "", cls, details: result.details };
            } catch (error) {
                return { id, text: "", error: error as Error, cls };
            }
        },
        close() {
            jig.remove();
            kubectl.remove();
        },
    };
}

/** The text of a call that must have worked; a failure or a block fails the test with the message. */
export function ok(result: CallResult): string {
    if (result.blocked !== undefined) throw new Error(`expected the call to work, but it was blocked: ${result.blocked}`);
    if (result.error !== undefined) throw new Error(`expected the call to work, but it failed: ${result.error.message}`);
    return result.text;
}
