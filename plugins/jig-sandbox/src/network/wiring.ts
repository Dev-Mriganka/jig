// Wiring the network pieces of one sandbox: the questions about a host (`ask` mode), the bridge that carries `localhost` ports into
// commands (`filtered` and `ask`), and the policy the proxy's callback asks. They are built from what the plugin around the sandbox
// gives, and they read the sandbox's state through `view`, so the sandbox class does not hold their wiring.
import { createAllowed } from "../allowed.ts";
import type { NetworkMode } from "../config.ts";
import { onPath } from "../programs.ts";
import type { SandboxDeps } from "../sandbox-types.ts";
import { createHostAsker } from "./ask-host.ts";
import type { HostAsker } from "./ask-host.ts";
import { Bridge } from "./bridge.ts";
import { createPolicy } from "./policy.ts";
import type { Policy } from "./policy.ts";

/** What the network pieces read of the sandbox as it is now. */
export interface SandboxView {
    mode(): NetworkMode;
    socat(): string | undefined;
    canWrite(place: string): boolean;
}

export function wireNetwork(
    deps: SandboxDeps,
    view: SandboxView,
): { hostAsker: HostAsker; bridge: Bridge; policy: Policy } {
    const network = deps.network ?? {};
    const allowed = network.allowed ?? createAllowed(deps.agentDir);
    const hostAsker = createHostAsker({
        allowed,
        screen: network.screen ?? (() => undefined),
        inTurn: network.inTurn ?? ((job) => job()),
        now: deps.now,
        ...(network.onceMs === undefined ? {} : { onceMs: network.onceMs }),
        ...(network.notify === undefined ? {} : { notify: network.notify }),
    });
    const bridge = new Bridge({
        mode: () => view.mode(),
        localhost: () => deps.settings().network.localhost,
        socat: () => view.socat(),
        python: () =>
            "python" in network ? network.python : onPath("python3", deps.env.PATH, (place) => view.canWrite(place)),
        platform: deps.platform,
        now: deps.now,
        ...(network.processes === undefined ? {} : { processes: network.processes }),
        ...(network.enter === undefined ? {} : { enter: network.enter }),
        ...(network.notify === undefined ? {} : { notify: network.notify }),
    });
    const policy = createPolicy({
        config: () => {
            const settings = deps.settings();
            return {
                mode: view.mode(),
                allow: settings.network.allow,
                deny: settings.network.deny,
                localhost: settings.network.localhost,
            };
        },
        bridged: (port) => bridge.serves(port),
        allowedHosts: () => hostAsker.allowed(),
        ask: (host, port) => hostAsker.ask(host, port),
        ...(network.own === undefined ? {} : { own: network.own }),
        ...(network.range === undefined ? {} : { range: network.range }),
    });
    return { hostAsker, bridge, policy };
}
