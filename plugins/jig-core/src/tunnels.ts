// Tunnels: how a company plugin gives a tool a network route of its own, such as a database behind a jump host.
//
// A transport carries one HTTP request; a database speaks its own protocol and needs a port. A tunnel provider opens a
// local port, and the tool connects to 127.0.0.1 on it. The port is a `forward` that reaches the target, or a `socks` proxy
// that reaches any host the far side can. The provider is code from another
// package, so what it gives back is checked here, where its mistake would otherwise show up as a confusing failure.
import type { OpenedTunnel, TunnelProvider } from "./contract.ts";
import { errorMessage } from "./errors.ts";
import { printable } from "./kit/text.ts";

export interface Tunnels {
    register(name: string, provider: TunnelProvider): void;
    open(name: string, target: { host: string; port: number }, signal?: AbortSignal): Promise<OpenedTunnel>;
}

const MAX_NAMES_SHOWN = 10;

function validPort(port: unknown): port is number {
    return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function createTunnels(): Tunnels {
    const providers = new Map<string, TunnelProvider>();
    return {
        register(name, provider) {
            if (typeof name !== "string" || name.trim() === "") throw new TypeError("a tunnel provider needs a name");
            if (typeof provider !== "object" || provider === null || typeof provider.open !== "function") {
                throw new TypeError(`tunnel provider "${printable(name)}" must have an open function`);
            }
            providers.set(name, provider);
        },

        async open(name, target, signal) {
            const provider = providers.get(name);
            if (provider === undefined) {
                const names = [...providers.keys()].slice(0, MAX_NAMES_SHOWN).map(printable);
                const known = names.length === 0 ? "none is registered" : `registered: ${names.join(", ")}`;
                throw new Error(
                    `no tunnel provider named "${printable(name)}" (${known}); a company plugin registers it`,
                );
            }
            if (typeof target?.host !== "string" || target.host === "" || !validPort(target.port)) {
                throw new TypeError("a tunnel needs a target host and a port from 1 to 65535");
            }
            let tunnel: unknown;
            try {
                tunnel = await provider.open({ host: target.host, port: target.port }, signal);
            } catch (error) {
                throw new Error(`tunnel provider "${printable(name)}" failed: ${errorMessage(error)}`);
            }
            const who = `tunnel provider "${printable(name)}"`;
            if (typeof tunnel !== "object" || tunnel === null) throw new TypeError(`${who} returned no tunnel`);
            const { port, close, kind } = tunnel as Record<string, unknown>;
            if (!validPort(port)) throw new TypeError(`${who} returned a tunnel without a valid local port`);
            if (typeof close !== "function") throw new TypeError(`${who} returned a tunnel that cannot be closed`);
            // A provider that does not say what its port is gives a forward, as every provider did before kinds.
            if (kind !== undefined && kind !== "forward" && kind !== "socks") {
                throw new TypeError(`${who} returned a tunnel whose kind is not forward or socks`);
            }
            return { kind: kind ?? "forward", port, close: () => (close as () => void | Promise<void>).call(tunnel) };
        },
    };
}
