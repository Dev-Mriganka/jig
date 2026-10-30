// Everything a tool test needs: the fake jig-core with a `logs` section, a fake backend (a server on 127.0.0.1 for the
// direct backend, or a transport), and the tool itself. `call` runs a call the way jig-core does: it classifies the
// call first, then runs it.
import type { TestContext } from "node:test";
import type { CallClass } from "../../../jig-core/src/contract.ts";
import { validateLogsSection } from "../../src/config.ts";
import { createLogsTool } from "../../src/tool.ts";
import type { JigTool } from "../../src/tool.ts";
import { fakeTransport, fixtureResponder, PUBLIC_URL, routeTo, startServer } from "./fake-search.ts";
import type { Doc, FakeTransport, Json, Recorded, Responder } from "./fake-search.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";

/** Wednesday, 13 October 2026, 12:00 UTC: the moment every relative window ends. */
export const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

/** Two environments of one backend: one index of its own, and one index shared with a filter. */
export const ENVIRONMENTS: Json = {
    staging: { index: "app-staging-*" },
    prod: { index: "app-*", filter: { "env.keyword": "prod" }, jigEnvironment: "production" },
};

export interface WorldOptions {
    /** How requests travel. Default: direct. */
    backend?: "direct" | "transport";
    /** The `auth` of a direct backend, as jig.json writes it. Default: a bearer token held under `env:LOGS_TOKEN`. */
    auth?: Json;
    /** What the backend knows. Ignored when there is a responder. */
    docs?: readonly Doc[];
    responder?: Responder;
    environments?: Json;
    /** How long one request may take. Default: long enough that no test waits for it. */
    timeoutMs?: number;
    /** The transport ignores its signal. */
    ignoreSignal?: boolean;
    /** The `logs` section, replacing the one made from the options above. */
    section?: unknown;
}

export interface CallResult {
    /** The text the model gets. Empty when the call failed. */
    text: string;
    /** The error the call threw, which Pi turns into a failed result. */
    error?: Error;
    /** How jig-core would classify the call. Undefined when classifying threw. */
    cls?: CallClass;
    /** Why classifying threw, if it did. */
    classifyError?: Error;
    details?: any;
    /** Progress texts sent while the call ran. */
    updates: string[];
}

export interface World {
    jig: FakeJig;
    tool: JigTool;
    /** Requests the backend received, in order, whichever way they travelled. */
    requests: Recorded[];
    transport?: FakeTransport;
    call(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<CallResult>;
}

/** The section a world configures. */
export function logsSection(options: WorldOptions = {}): Json {
    const backend =
        options.backend === "transport"
            ? { transport: "corp", url: PUBLIC_URL }
            : { url: PUBLIC_URL, auth: options.auth ?? { token: "env:LOGS_TOKEN" } };
    return { backend, environments: options.environments ?? ENVIRONMENTS };
}

export async function world(t: TestContext, options: WorldOptions = {}): Promise<World> {
    const jig = installFakeJig();
    t.after(() => jig.remove());
    jig.secrets.set("env:LOGS_TOKEN", "token-value-1234");

    const responder = options.responder ?? fixtureResponder(options.docs ?? []);
    let requests: Recorded[];
    let transport: FakeTransport | undefined;
    if (options.backend === "transport") {
        transport = fakeTransport(responder, { ignoreSignal: options.ignoreSignal === true });
        jig.transports.set("corp", transport);
        requests = transport.requests;
    } else {
        const server = await startServer(responder);
        t.after(() => server.close());
        jig.setFetch(routeTo(server));
        requests = server.requests;
    }

    // What the plugin's factory does with jig-core, with the parts a test replaces.
    const tool = createLogsTool({ now: () => NOW, timeoutMs: options.timeoutMs ?? 20_000 });
    jig.api.declareTool(tool.declaration);
    jig.api.config.registerSection("logs", validateLogsSection);
    jig.setSection("logs", options.section ?? logsSection(options));

    let counter = 0;
    return {
        jig,
        tool,
        requests,
        ...(transport === undefined ? {} : { transport }),
        async call(input, callOptions = {}) {
            const updates: string[] = [];
            const result: CallResult = { text: "", updates };
            try {
                result.cls = tool.declaration.classify(input);
            } catch (error) {
                result.classifyError = error as Error;
            }
            try {
                const onUpdate = (partial: { content: Array<{ type: string; text?: string }> }) => {
                    updates.push(partial.content[0]?.text ?? "");
                };
                const reply = await tool.definition.execute(
                    `call-${++counter}`,
                    input as never,
                    callOptions.signal,
                    onUpdate as never,
                    {} as never,
                );
                const first = reply.content[0];
                result.text = first !== undefined && first.type === "text" ? first.text : "";
                result.details = reply.details;
            } catch (error) {
                result.error = error as Error;
            }
            return result;
        },
    };
}

/** The text of a call that must have worked; a failure fails the test with the tool's own message. */
export function ok(result: CallResult): string {
    if (result.error !== undefined)
        throw new Error(`expected the call to work, but it failed: ${result.error.message}`);
    return result.text;
}

/**
 * Documents half a minute apart, oldest first, from `start` (25 minutes before NOW, so a 30 minute window holds up to
 * 50 of them). `message` makes each one's text; the filter of `prod` finds the ones with `env: "prod"`.
 */
export function docs(
    count: number,
    options: { start?: number; stepMs?: number; message?: (n: number) => string; env?: string } = {},
): Doc[] {
    const start = options.start ?? NOW - 25 * 60_000;
    const stepMs = options.stepMs ?? 30_000;
    return Array.from({ length: count }, (_, n) => ({
        "@timestamp": new Date(start + n * stepMs).toISOString(),
        message: options.message?.(n) ?? `message ${n}`,
        env: options.env ?? "staging",
    }));
}
