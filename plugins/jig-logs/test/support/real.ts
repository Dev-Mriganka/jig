// The `logs` tool as a user runs it against a real backend: jig-core's request code (`kit/http.ts`) sends the requests over
// the real network, and only what needs a session (secrets, sign-in services, the screen) is the fake jig-core the other
// tests of this plugin use. Used by the tests in `test/it/`, which run when a backend's address is set.
import type { TestContext } from "node:test";
import type { Transport } from "../../../jig-core/src/contract.ts";
import { validateLogsSection } from "../../src/config.ts";
import { createLogsTool } from "../../src/tool.ts";
import type { JigTool } from "../../src/tool.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";
import { caller } from "./world.ts";
import type { World } from "./world.ts";

export interface RealOptions {
    /** The `logs` section, as jig.json writes it. */
    section: unknown;
    /** The instant a relative window ends. Default: the real clock. */
    now?: number;
    /** Secret values by reference, as the secret store would give them. */
    secrets?: Readonly<Record<string, string>>;
    /** How long one request may take. Default 30 seconds, as in use. */
    timeoutMs?: number;
}

export interface RealWorld {
    jig: FakeJig;
    tool: JigTool;
    call: World["call"];
    /** Points the tool at another `logs` section, as an edit of jig.json would. */
    configure(section: unknown): void;
}

export function realWorld(t: TestContext, options: RealOptions): RealWorld {
    const jig = installFakeJig();
    t.after(() => jig.remove());
    for (const [reference, value] of Object.entries(options.secrets ?? {})) jig.secrets.set(reference, value);

    const now = options.now;
    const tool = createLogsTool({
        ...(now === undefined ? {} : { now: () => now }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    jig.api.declareTool(tool.declaration);
    jig.api.config.registerSection("logs", validateLogsSection);
    jig.setSection("logs", options.section);
    return { jig, tool, call: caller(tool), configure: (section) => jig.setSection("logs", section) };
}

/**
 * A transport that carries the request as it is, with the network and nothing else: no sign-in, as for a backend that
 * has none. A company plugin registers one of its own that signs in; this one stands in for it, so a backend that speaks
 * plain HTTP can be reached by the code path a transport takes.
 */
export const plainTransport: Transport = {
    async request(request, signal) {
        const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            redirect: "manual",
            ...(request.body === undefined ? {} : { body: request.body }),
            ...(signal === undefined ? {} : { signal }),
        });
        return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
    },
};
