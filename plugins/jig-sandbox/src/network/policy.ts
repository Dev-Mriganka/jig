// The callback's decision about one connection the sandbox's proxy asks about: allow it, refuse it with a reason the agent can
// act on, or (in `ask` mode) ask you. The runtime runs the callback in the broker and the broker asks Pi, so everything here is
// ordinary code that tests can call.
//
// What is refused whatever else is configured: cloud metadata addresses and names, and every address that reaches this machine
// or its neighbours (loopback, this machine's own addresses, link-local, private, carrier-grade NAT) except a port you listed in
// `network.localhost` (loopback and this machine's own addresses only) or a port a background task's server is bridged on
// (loopback only). The proxy dials an approved IP address with no check of its own, which is why these are checked here.
import type { NetworkMode } from "../config.ts";
import { canonicalAddress, classifyHost, cleanHost, ownAddresses } from "./addresses.ts";
import type { Range } from "./addresses.ts";
import { firstMatch, hostPort } from "./hosts.ts";

export type Decision = { allow: true } | { allow: false; reason: string };

export interface PolicyConfig {
    mode: NetworkMode;
    /** `network.allow`: hosts allowed without asking, in `ask` mode. */
    allow: readonly string[];
    deny: readonly string[];
    /** `network.localhost`: ports on this machine that commands may reach. */
    localhost: readonly number[];
}

export interface PolicyDeps {
    config: () => PolicyConfig;
    /** Whether a port on the loopback address is bridged to a background task's server. */
    bridged: (port: number) => boolean;
    /** Hosts you allowed (once, for this session or always), as patterns. */
    allowedHosts: () => readonly string[];
    /** Asks you about a host `ask` mode has not met. */
    ask: (host: string, port: number) => Promise<Decision>;
    /** This machine's own addresses. Default: the interfaces now. A test replaces it. */
    own?: () => readonly string[];
    /** Tests only: changes the range of an address (given the real one), so a loopback alias can stand in for a public host. */
    range?: (address: string, real: Range | undefined) => Range | undefined;
}

const refuse = (reason: string): Decision => ({ allow: false, reason });

/** Why an address in this range is refused, in words that name the way through where there is one. */
function rangeReason(shown: string, range: Range): string {
    switch (range) {
        case "metadata":
            return `${shown} is a cloud metadata address, and those are always blocked`;
        case "loopback":
            return `${shown} is this machine's own address; list its port in sandbox.network.localhost to reach a service on it`;
        case "own":
            return `${shown} is one of this machine's own addresses; list its port in sandbox.network.localhost to reach a service on it`;
        case "link-local":
            return `${shown} is a link-local address, which is always blocked`;
        case "private":
            return `${shown} is a private network address, which is always blocked`;
        case "carrier":
            return `${shown} is in 100.64.0.0/10 (carrier-grade NAT, used by VPNs such as Tailscale), which is always blocked`;
        default:
            return `${shown} is not a public address`;
    }
}

export function createPolicy(deps: PolicyDeps) {
    /** Allow, refuse or ask, without asking. */
    function judge(host: string, port: number): Decision | "ask" {
        const config = deps.config();
        const own = new Set((deps.own ?? ownAddresses)().map((address) => canonicalAddress(address) ?? address));
        const kind = classifyHost(host, own);
        const cleaned = cleanHost(host);
        const shown = hostPort(cleaned, port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return refuse(`${cleaned} was asked for with no valid port, so it cannot be checked`);
        }
        if (kind.kind === "invalid") {
            return refuse(`${shown} is not a valid host name or address, so it cannot be checked`);
        }
        if (kind.kind === "name" && kind.metadata) return refuse(rangeReason(shown, "metadata"));
        if (kind.kind === "ip" && kind.range === "metadata") return refuse(rangeReason(shown, "metadata"));

        const denied = firstMatch(config.deny, cleaned, port);
        if (denied !== undefined) return refuse(`${shown} is on sandbox.network.deny (${denied})`);

        // This machine: loopback and its own addresses, by name or by number.
        let range: Range | undefined;
        if (kind.kind === "name") range = kind.localhost ? "loopback" : undefined;
        else range = deps.range === undefined ? kind.range : deps.range(kind.address, kind.range);
        if (range !== undefined) {
            if (range === "loopback" || range === "own") {
                if (config.localhost.includes(port)) return { allow: true };
                if (range === "loopback" && deps.bridged(port)) return { allow: true };
            }
            return refuse(rangeReason(shown, range));
        }

        if (config.mode === "filtered") return { allow: true };
        // `ask`: a host you or the configuration allowed passes; any other waits for your answer.
        if (firstMatch([...config.allow, ...deps.allowedHosts()], cleaned, port) !== undefined) return { allow: true };
        return "ask";
    }

    return {
        /** The answer for one connection. Never throws: a failure is a refusal, which is what the runtime does too. */
        async decide(host: string, port: number): Promise<Decision> {
            try {
                const verdict = judge(host, port);
                if (verdict !== "ask") return verdict;
                return await deps.ask(cleanHost(host), port);
            } catch (error) {
                return refuse(`the sandbox could not decide (${(error as Error).message})`);
            }
        },
        /** Allow, refuse or ask, without asking: for tests and the doctor. */
        judge,
    };
}

export type Policy = ReturnType<typeof createPolicy>;
