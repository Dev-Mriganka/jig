// A harness with a fake CI server behind it, for the tests of the GitLab and Jenkins adapters: the plugin loaded into a fake Pi,
// a catalog entry that names `https://ci.example.test`, and a real server on 127.0.0.1 that answers it (or a transport that
// answers it). The server is closed when the test ends.
import type { TestContext } from "node:test";
import { setupHarness } from "./harness.ts";
import type { Harness } from "./harness.ts";
import { fakeTransport, routeTo, startServer } from "./fake-server.ts";
import type { FakeServer, FakeTransport, Responder } from "./fake-server.ts";
import { withCi } from "./section.ts";
import type { Raw } from "./section.ts";

export interface CiWorld {
    h: Harness;
    server: FakeServer;
    /** The requests the server got, in order. Through a transport: the ones the transport got. */
    requests: FakeServer["requests"];
    /** Runs a ci call for orders-api. */
    call(
        input: Record<string, unknown>,
        options?: Parameters<Harness["ci"]["call"]>[1],
    ): ReturnType<Harness["ci"]["call"]>;
    transport?: FakeTransport;
}

export interface CiWorldOptions {
    /** The `ci` entry of orders-api. */
    ci: Raw;
    /** Other settings of the `ops` section. */
    ops?: Raw;
    responder: Responder;
    /** Secret values by reference. */
    secrets?: Record<string, string>;
    /** How long one request may take. Default: long enough that no test waits for it. */
    timeoutMs?: number;
    /** Answer through a transport of this name instead of over the network. */
    transport?: string;
    /** The network, instead of the fake server: for a failure the server cannot make. */
    fetch?: typeof fetch;
}

export async function ciWorld(t: TestContext, options: CiWorldOptions): Promise<CiWorld> {
    const server = await startServer(options.responder);
    t.after(() => server.close());
    const transport = options.transport === undefined ? undefined : fakeTransport(options.responder);
    const h = setupHarness({ fetch: options.fetch ?? routeTo(server), timeoutMs: options.timeoutMs ?? 20_000 });
    t.after(() => h.close());
    h.configure(withCi(options.ci, options.ops));
    for (const [reference, value] of Object.entries(options.secrets ?? {})) h.jig.secrets.set(reference, value);
    if (transport !== undefined && options.transport !== undefined) h.jig.transports.set(options.transport, transport);
    return {
        h,
        server,
        requests: transport === undefined ? server.requests : transport.requests,
        call: (input, callOptions) => h.ci.call({ service: "orders-api", ...input }, callOptions),
        ...(transport === undefined ? {} : { transport }),
    };
}
