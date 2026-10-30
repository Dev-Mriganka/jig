// Everything a tool test needs: a sandbox with real repositories, the fake jig-core, a fake gh, and the plugin loaded into a
// fake Pi the way Pi loads it. `call` then runs a tool call the way jig-core runs one: classify it, ask for the preview when
// the call asks (a write outside the machine, or a class that asks by default), keep the approved preview, and execute.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CallClass, Preview } from "../../../jig-core/src/contract.ts";
import plugin from "../../src/index.ts";
import { forgetDefaultBranches, setWorkingDirectory } from "../../src/repo.ts";
import { installFakeGh } from "./fake-gh.ts";
import type { FakeGh } from "./fake-gh.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";
import { sandbox } from "./repos.ts";
import type { Sandbox } from "./repos.ts";

export interface Announced {
    event: string;
    payload: unknown;
}

export interface CallOptions {
    /** Pi's working directory for this call. Default: the sandbox workspace. */
    cwd?: string;
    /** Force or forbid the ask. Default: ask as the default rules table does. */
    ask?: boolean;
    /** Runs after the preview was approved and before the tool runs: what changes while the user reads. */
    between?: () => void | Promise<void>;
    signal?: AbortSignal;
}

export interface CallResult {
    /** The text the model gets. Empty when the call failed. */
    text: string;
    /** The error the tool threw, which Pi turns into a failed result. */
    error?: Error;
    cls?: CallClass;
    /** The preview that was approved, when the call asked. */
    preview?: Preview;
    details?: unknown;
}

export interface Harness {
    sb: Sandbox;
    jig: FakeJig;
    gh: FakeGh;
    tools: Map<string, ToolDefinition>;
    announced: Announced[];
    /** Forgets what earlier tests did: the programs run, the watches started, the settings, the fake gh's fixtures. */
    reset(): void;
    call(name: string, input: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
    cleanup(): void;
}

export function setupHarness(): Harness {
    const sb = sandbox();
    const jig = installFakeJig();
    const gh = installFakeGh(sb);
    const tools = new Map<string, ToolDefinition>();
    const announced: Announced[] = [];
    const pi = {
        registerTool: (tool: ToolDefinition) => void tools.set(tool.name, tool),
        on: () => () => {},
        events: {
            emit: (event: string, payload: unknown) => void announced.push({ event, payload }),
            on: () => () => {},
        },
    } as unknown as ExtensionAPI;
    plugin(pi);
    setWorkingDirectory(sb.workspace);
    forgetDefaultBranches();
    let counter = 0;
    return {
        sb,
        jig,
        gh,
        tools,
        announced,
        reset() {
            jig.reset();
            gh.reset();
            announced.length = 0;
            setWorkingDirectory(sb.workspace);
        },
        async call(name, input, options = {}) {
            const id = `call-${++counter}`;
            const tool = tools.get(name);
            if (!tool) throw new Error(`no tool ${name}`);
            const declaration = jig.declared.get(name);
            const cls = declaration?.classify(input);
            const asks =
                options.ask ??
                (cls === undefined || (cls.environment !== "local" && cls.effect === "write") || cls.atLeast === "ask");
            let preview: Preview | undefined;
            try {
                if (asks && declaration?.preview) {
                    preview = await declaration.preview(input, options.signal ?? new AbortController().signal);
                    jig.approved.set(id, preview);
                }
                await options.between?.();
                const result = await tool.execute(id, input as never, options.signal, undefined, {
                    cwd: options.cwd ?? sb.workspace,
                } as unknown as ExtensionToolContext);
                const first = result.content[0];
                return {
                    text: first && first.type === "text" ? first.text : "",
                    cls,
                    preview,
                    details: result.details,
                };
            } catch (error) {
                return { text: "", error: error as Error, cls, preview };
            }
        },
        cleanup() {
            jig.remove();
            sb.cleanup();
        },
    };
}

/** The text of a call that must have worked; a failure fails the test with the tool's own message. */
export function ok(result: CallResult): string {
    if (result.error) throw new Error(`expected the call to work, but it failed: ${result.error.message}`);
    return result.text;
}
