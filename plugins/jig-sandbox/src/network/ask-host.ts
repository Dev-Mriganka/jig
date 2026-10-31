// Asking you about a host, in `ask` mode, while the connection waits. The question goes through jig-core's approval queue, so
// it never opens over one of jig-core's own; with no screen to ask on the answer is no. Four answers:
//   Once          this host and port for the next few seconds, so a command that opens several connections asks once
//   This session  until Pi ends
//   Always        kept in `<agent folder>/jig-sandbox/allowed.json`, which the sandbox cannot write
//   No            refused, with the reason in the refusal the command sees
// Connections to one host and port that arrive while the question is open share it.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Allowed } from "../allowed.ts";
import { entryFor, firstMatch, hostPort } from "./hosts.ts";
import type { Decision } from "./policy.ts";

const ONCE = "Once";
const SESSION = "This session";
const ALWAYS = "Always";
const NO = "No";

/** How long an answer of Once lasts. */
export const ONCE_MS = 15_000;
/** The question closes itself if nobody answers, and the connection is refused. */
const QUESTION_TIMEOUT_MS = 120_000;

/** The part of Pi's context a question needs. */
export type Screen = Pick<ExtensionContext, "ui" | "hasUI">;

export interface HostAskerDeps {
    allowed: Allowed;
    /** The screen to ask on: the latest one Pi gave this plugin, or undefined. */
    screen: () => Screen | undefined;
    /** Runs a question in jig-core's queue; without jig-core, this plugin's own. */
    inTurn: <T>(job: () => Promise<T>) => Promise<T>;
    now?: () => number;
    onceMs?: number;
    /** Tells you what could not be kept. */
    notify?: (message: string) => void;
}

export interface HostAsker {
    ask(host: string, port: number): Promise<Decision>;
    /** What is allowed now without asking, as patterns: the session's, the kept ones and a recent Once. */
    allowed(): string[];
}

export function createHostAsker(deps: HostAskerDeps): HostAsker {
    const now = deps.now ?? Date.now;
    const onceMs = deps.onceMs ?? ONCE_MS;
    /** A recent answer of Once: host:port -> when it ends. */
    const once = new Map<string, number>();
    const pending = new Map<string, Promise<Decision>>();

    const recent = (): string[] => {
        for (const [key, until] of once) if (until <= now()) once.delete(key);
        return [...once.keys()];
    };
    const allowedNow = (): string[] => [...deps.allowed.hosts(), ...recent()];

    async function question(host: string, port: number): Promise<Decision> {
        const screen = deps.screen();
        const shown = hostPort(host, port);
        if (screen === undefined || !screen.hasUI) {
            return {
                allow: false,
                reason: `${shown} is not allowed, and there is no screen to ask on. A person can allow it with /sandbox allowed add ${host.includes(":") ? `[${host}]` : host}`,
            };
        }
        return deps.inTurn(async (): Promise<Decision> => {
            // Another connection's question may have been answered while this one waited its turn.
            if (firstMatch(allowedNow(), host, port) !== undefined) return { allow: true };
            const title = [
                `bash wants to reach ${shown}.`,
                "The network mode is ask: a new host waits for your answer.",
            ].join("\n");
            let answer: string | undefined;
            try {
                answer = await screen.ui.select(title, [ONCE, SESSION, ALWAYS, NO], { timeout: QUESTION_TIMEOUT_MS });
            } catch (error) {
                return {
                    allow: false,
                    reason: `${shown} was refused: the question failed (${(error as Error).message})`,
                };
            }
            const entry = entryFor(host, port);
            if (answer === ONCE) {
                once.set(entry, now() + onceMs);
                return { allow: true };
            }
            if (answer === SESSION) {
                deps.allowed.allowHostSession(entry);
                return { allow: true };
            }
            if (answer === ALWAYS) {
                try {
                    deps.allowed.allowHostAlways(entry);
                } catch (error) {
                    deps.allowed.allowHostSession(entry);
                    deps.notify?.(
                        `${entry} is allowed for this session only: the answer could not be kept (${(error as Error).message}).`,
                    );
                }
                return { allow: true };
            }
            return {
                allow: false,
                reason:
                    answer === undefined
                        ? `${shown} was refused: the question was closed without an answer`
                        : `${shown} was refused: the user said no. Do not try another way round it`,
            };
        });
    }

    return {
        allowed: allowedNow,
        ask(host, port) {
            const key = entryFor(host, port);
            const open = pending.get(key);
            if (open !== undefined) return open;
            const started = question(host, port).finally(() => pending.delete(key));
            pending.set(key, started);
            return started;
        },
    };
}
