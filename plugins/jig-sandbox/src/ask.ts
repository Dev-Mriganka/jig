// Asking the user about a write to an ask-first folder: after the command, inside the waiting tool call, as every Jig
// approval is. Questions from commands that run at the same time wait in line and are asked one at a time. The answer
// widens the rules from the next command on; the agent is told to run the command again.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Allowed } from "./allowed.ts";
import type { Rule } from "./rules.ts";
import { shown } from "./pathing.ts";

const THIS_SESSION = "This session";
const ALWAYS = "Always";
const NO = "No";

export interface Asker {
    /** The lines for the agent after the question, or after the reason there was none. */
    ask(ctx: ExtensionContext, rule: Rule, refused: string): Promise<string[]>;
}

/** A queue of its own: one job at a time, and a job that fails does not stop the ones behind it. */
export function serialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    return (job) => {
        const turn = tail.then(job, job);
        tail = turn.catch(() => undefined);
        return turn;
    };
}

/**
 * The asker for writes to an ask-first folder. Its questions wait in `inTurn`: jig-core's queue when it is loaded, so they never
 * open over one of its own or over a question about a host, and a queue of this plugin's own otherwise.
 */
export function createAsker(allowed: Allowed, home: () => string, queue?: ReturnType<typeof serialQueue>): Asker {
    const inTurn = queue ?? serialQueue();

    return {
        ask(ctx, rule, refused) {
            const folder = rule.shown;
            if (!ctx.hasUI) {
                return Promise.resolve([
                    `[sandbox] writes to ${folder} are not allowed, and there is no screen to ask on. A person can allow them with /sandbox allowed add ${folder}.`,
                ]);
            }
            return inTurn(async () => {
                // Another command's question may have been answered while this one waited.
                if (allowed.folders().includes(rule.path)) {
                    return [`[sandbox] writes to ${folder} are allowed now; run the command again.`];
                }
                if (ctx.signal?.aborted === true) return [];
                const title = [
                    `bash was stopped from writing ${shown(refused, home())}.`,
                    `${capitalize(rule.reason)}.`,
                    `Allow writes to ${folder}?`,
                ].join("\n");
                const answer = await ctx.ui.select(
                    title,
                    [THIS_SESSION, ALWAYS, NO],
                    ctx.signal === undefined ? undefined : { signal: ctx.signal },
                );
                if (answer === THIS_SESSION) {
                    allowed.allowSession(rule.path);
                    return [`[sandbox] the user allowed writes to ${folder} for this session; run the command again.`];
                }
                if (answer === ALWAYS) {
                    try {
                        allowed.allowAlways(rule.path);
                        return [`[sandbox] the user allowed writes to ${folder} always; run the command again.`];
                    } catch (error) {
                        allowed.allowSession(rule.path);
                        return [
                            `[sandbox] the user allowed writes to ${folder} for this session only, since the answer could not be kept (${(error as Error).message}); run the command again.`,
                        ];
                    }
                }
                return [
                    `[sandbox] writes to ${folder} stay refused: the user said no${answer === undefined ? " (the question was closed)" : ""}. Do not try another way round it.`,
                ];
            });
        },
    };
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
