// Gates: checks that other plugins register, asked about each call once the rules have decided. A gate can make the
// decision stricter and never looser: an `allow` becomes an `ask` or a `deny`, an `ask` becomes a `deny`. That is the whole
// contract, and this file is where it is kept: the answer `allow`, or any shape that is not `ask` or `deny`, is no answer.
//
// A gate that fails (throws, or takes too long) denies the call. A tool must never run because jig-core could not tell
// whether a gate would have stopped it.
import type { Gate, GateCall, GateVerdict } from "./contract.ts";
import { errorMessage } from "./errors.ts";

/** How long one gate may take to answer. */
export const GATE_TIMEOUT_MS = 10_000;
/** The longest reason that is kept. Longer text is cut: a reason is a line for the model and the user, not a report. */
const MAX_REASON_CHARS = 500;

/** What the gates said about one call. Absent when none of them had anything to say. */
export interface GateOutcome {
    decision: "ask" | "deny";
    /** The gate that said it. */
    gate: string;
    plugin: string;
    reason: string;
    /** True when the gate could not answer (it threw, or ran out of time), so the call is denied. */
    failed: boolean;
}

export interface Gates {
    register(gate: Gate): void;
    /** The gates in the order they were registered. */
    list(): readonly Gate[];
    /** Asks every gate about the call, and returns the strictest answer. A deny ends the asking. */
    check(call: GateCall): Promise<GateOutcome | undefined>;
    /** Gates that answered with something that is not `ask` or `deny`, for `/jig`. */
    problems(): readonly string[];
}

export interface GatesOptions {
    timeoutMs?: number;
}

export function createGates(options: GatesOptions = {}): Gates {
    const timeoutMs = options.timeoutMs ?? GATE_TIMEOUT_MS;
    const gates = new Map<string, Gate>();
    const problems = new Set<string>();

    async function askOne(gate: Gate, call: GateCall): Promise<GateOutcome | undefined> {
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        const tooSlow = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error(`it took longer than ${Math.max(1, Math.round(timeoutMs / 1000))} s`));
            }, timeoutMs);
        });
        try {
            const answer: unknown = await Promise.race([
                Promise.resolve().then(() => gate.check(call, controller.signal)),
                tooSlow,
            ]);
            return outcomeOf(gate, answer);
        } catch (error) {
            return {
                decision: "deny",
                gate: gate.name,
                plugin: gate.plugin,
                reason: `jig-core could not decide: gate "${gate.name}" (${gate.plugin}) failed: ${clean(errorMessage(error))}`,
                failed: true,
            };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    /** The gate's answer as an outcome, or undefined when it has none. Only `ask` and `deny` count. */
    function outcomeOf(gate: Gate, answer: unknown): GateOutcome | undefined {
        if (answer === undefined || answer === null) return undefined;
        const verdict = answer as Partial<GateVerdict>;
        if ((verdict.decision === "ask" || verdict.decision === "deny") && typeof verdict.reason === "string") {
            const reason = clean(verdict.reason);
            if (reason !== "") {
                return { decision: verdict.decision, gate: gate.name, plugin: gate.plugin, reason, failed: false };
            }
        }
        // `allow` lands here too: a gate cannot loosen anything, so it has no answer to give. It is reported once.
        problems.add(
            `gate "${gate.name}" (${gate.plugin}) answered with something that is not ask or deny with a reason, so it was ignored`,
        );
        return undefined;
    }

    return {
        register(gate) {
            if (typeof gate?.name !== "string" || gate.name === "")
                throw new TypeError("gates.register: the gate needs a name");
            if (typeof gate.plugin !== "string" || gate.plugin === "") {
                throw new TypeError(`gates.register(${gate.name}): the plugin needs a name`);
            }
            if (typeof gate.check !== "function") {
                throw new TypeError(`gates.register(${gate.name}): check must be a function`);
            }
            gates.set(gate.name, gate);
        },
        list: () => [...gates.values()],
        async check(call) {
            let strictest: GateOutcome | undefined;
            for (const gate of gates.values()) {
                const outcome = await askOne(gate, call);
                if (outcome === undefined) continue;
                if (strictest === undefined || (outcome.decision === "deny" && strictest.decision === "ask")) {
                    strictest = outcome;
                }
                if (strictest.decision === "deny") break;
            }
            return strictest;
        },
        problems: () => [...problems],
    };
}

/** What a gate gives to the user and the model: one line of plain text, cut short. */
function clean(text: string): string {
    return text
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
        .trim()
        .slice(0, MAX_REASON_CHARS);
}

/** A copy of the call that a gate cannot use to change what runs: the input is cloned, and everything is frozen. */
export function frozenCall(call: GateCall): GateCall {
    return deepFreeze({
        ...call,
        input: structuredClone(call.input),
        paths: [...call.paths],
    });
}

function deepFreeze<T>(value: T): T {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
}
