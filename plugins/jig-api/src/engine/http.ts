// Sending a planned request: the headers, the body, the sign-in the plan asks for, one exchange, and the answer with every
// credential removed from it.
//
// A request is sent once, and never again after a timeout or a dropped connection: whether a write happened is then
// unknown, and the caller says so (see tool.ts). The one exception is a 401 for an OAuth token that came from the cache.
// That is the server turning the request down because the token has expired, before it acted on it, so sending it again with
// a new token cannot repeat a write.
import { jig } from "../../../jig-core/src/client.ts";
import { createTokens } from "./oauth.ts";
import type { Plan } from "./plan.ts";
import { credentialsOf, scrubbed } from "./scrub.ts";
import { fill, fillString } from "./text.ts";
import type { Fillers } from "./text.ts";
import { errorMessage } from "./values.ts";
import { exchange, NotSentError } from "./wire.ts";
import type { Answer, Stops, Wire } from "./wire.ts";

export interface HttpOptions {
    /** For tests: multiplies every timeout, so that a test of a lost reply does not wait for seconds. Default 1. */
    timeoutScale?: number;
    /** For tests: the clock, in milliseconds, that the token cache and the generated values read. Default `Date.now`. */
    now?: () => number;
}

/** An answer, and the sentences that explain it, such as why a 401 stayed a 401. */
export interface Sent {
    answer: Answer;
    notes: string[];
}

export interface Http {
    /** Throws NotSentError or LostReplyError. */
    send(plan: Plan, cancel?: AbortSignal): Promise<Sent>;
}

const OWN_HEADERS: ReadonlyArray<readonly [string, string]> = [
    ["Accept", "application/json, text/plain, */*"],
    ["User-Agent", "jig-api"],
];

/** The tool's headers, then the request's, which replace the tool's of the same name, then the sign-in's, which replace
 *  both. */
function mergedHeaders(
    own: ReadonlyArray<readonly [string, string]>,
    signIn: Readonly<Record<string, string>>,
): Record<string, string> {
    const merged = new Map<string, readonly [string, string]>();
    for (const [name, value] of [...OWN_HEADERS, ...own, ...Object.entries(signIn)]) merged.set(name.toLowerCase(), [name, value]);
    return Object.fromEntries(merged.values());
}

/** Fails when the sign-in sets a header that the request has itself: one of the two would silently win. */
function checkClash(own: ReadonlyArray<readonly [string, string]>, signIn: Readonly<Record<string, string>>): void {
    const given = new Set(own.map(([name]) => name.toLowerCase()));
    const clash = Object.keys(signIn).find((name) => given.has(name.toLowerCase()));
    if (clash !== undefined) throw new NotSentError(`header ${clash} is set by the sign-in, so the request cannot have it too`);
}

export function createHttp(options: HttpOptions = {}): Http {
    const timeoutScale = options.timeoutScale ?? 1;
    const now = options.now ?? Date.now;
    const tokens = createTokens(now);

    return {
        async send(plan, cancel) {
            // One deadline for every request the call makes, a token request included. The clock starts with the first
            // request that goes out: a secret store that waits for the user to unlock it is not the API's time.
            const timeoutMs = Math.max(1, Math.round(plan.timeoutSec * 1000 * timeoutScale));
            let clock: AbortSignal | undefined;
            const stops: Stops = {
                cancel,
                deadline() {
                    clock ??= AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(cancel === undefined ? [] : [cancel])]);
                    return clock;
                },
            };

            // What went out as a credential, to remove from the answer.
            const credentials: string[] = [];
            const notes: string[] = [];
            const fillers: Fillers = {
                secret: (reference) => jig().secrets.resolve(reference, cancel),
                now,
                credentials,
            };
            /** Fills a text. A secret that cannot be read stops the call before anything is sent. */
            const filled = async <T>(work: Promise<T>): Promise<T> => {
                try {
                    return await work;
                } catch (error) {
                    throw new NotSentError(`could not sign in (${errorMessage(error)})`);
                }
            };

            const own: Array<readonly [string, string]> = [];
            for (const [name, value] of plan.headers) own.push([name, await filled(fillString(value, fillers))]);
            const body = plan.body === undefined ? undefined : await filled(fill(plan.body, fillers));

            const wire = (signIn: Readonly<Record<string, string>>): Wire => {
                checkClash(own, signIn);
                return {
                    system: plan.system,
                    method: plan.method,
                    url: plan.url,
                    headers: mergedHeaders(own, signIn),
                    allowPlainLocal: plan.allowPlainLocal,
                    ...(body === undefined ? {} : { body }),
                    ...(plan.signIn.kind === "transport" ? { transport: plan.signIn.name } : {}),
                };
            };

            const { signIn } = plan;
            let answer: Answer;
            switch (signIn.kind) {
                case "none":
                case "transport":
                    // A transport adds the session itself, and the tool adds nothing.
                    answer = await exchange(wire({}), stops.deadline());
                    break;
                case "bearer": {
                    const token = await filled(fillString(signIn.token, fillers));
                    credentials.push(token);
                    answer = await exchange(wire({ Authorization: `Bearer ${token}` }), stops.deadline());
                    break;
                }
                case "basic": {
                    const [user, password] = await filled(Promise.all([fillString(signIn.username, fillers), fillString(signIn.password, fillers)]));
                    const pair = Buffer.from(`${user}:${password}`).toString("base64");
                    credentials.push(pair, password);
                    answer = await exchange(wire({ Authorization: `Basic ${pair}` }), stops.deadline());
                    break;
                }
                case "apiKey": {
                    const key = await filled(fillString(signIn.value, fillers));
                    credentials.push(key);
                    answer = await exchange(wire({ [signIn.name]: key }), stops.deadline());
                    break;
                }
                case "service": {
                    // Asked for every request: the service decides when its token has expired.
                    let headers: Readonly<Record<string, string>>;
                    try {
                        headers = await jig().signIn.headers(signIn.name, { system: plan.system, url: plan.url }, cancel);
                    } catch (error) {
                        throw new NotSentError(`could not sign in (${errorMessage(error)})`);
                    }
                    credentials.push(...credentialsOf(headers));
                    answer = await exchange(wire({ ...headers }), stops.deadline());
                    break;
                }
                case "oauth": {
                    const login = {
                        scope: `${plan.system}/${plan.environment}`,
                        system: plan.system,
                        allowPlainLocal: plan.allowPlainLocal,
                        fillers,
                    };
                    let token = await tokens.get(login, signIn, stops);
                    credentials.push(token.value);
                    answer = await exchange(wire({ Authorization: `Bearer ${token.value}` }), stops.deadline());
                    if (answer.status === 401 && !token.fresh) {
                        tokens.forget(login.scope);
                        token = await tokens.get(login, signIn, stops);
                        credentials.push(token.value);
                        answer = await exchange(wire({ Authorization: `Bearer ${token.value}` }), stops.deadline());
                    }
                    // A 401 that is left was for a new token: sending it again would change nothing.
                    if (answer.status === 401) {
                        notes.push("The server rejected a newly issued token: the account may lack access to this path.");
                    }
                    break;
                }
            }
            return { answer: scrubbed(answer, credentials), notes };
        },
    };
}
