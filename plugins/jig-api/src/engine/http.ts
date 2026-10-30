// Sending a planned call: the headers, the sign-in the target asks for, one exchange, and the answer with every credential
// removed from it.
//
// A request is sent once, and never again after a timeout or a dropped connection: whether a write happened is then
// unknown, and the caller says so (see tool.ts). The one exception is a 401 for an OAuth token that came from the cache.
// That is the server turning the request down because the token has expired, before it acted on it, so sending it again with
// a new token cannot repeat a write.
import { jig } from "../../../jig-core/src/client.ts";
import type { Call } from "../params.ts";
import { createTokens } from "./oauth.ts";
import type { Plan } from "./plan.ts";
import { credentialsOf, scrubbed } from "./scrub.ts";
import { errorMessage } from "./values.ts";
import { exchange, NotSentError } from "./wire.ts";
import type { Answer, Stops, Wire } from "./wire.ts";

export interface HttpOptions {
    /** For tests: multiplies every timeout, so that a test of a lost reply does not wait for seconds. Default 1. */
    timeoutScale?: number;
    /** For tests: the clock, in milliseconds, that the token cache reads. Default `Date.now`. */
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

/** The tool's headers, then the caller's, which replace the tool's of the same name, then the sign-in's, which replace
 *  both. */
function headersOf(call: Call, signIn: Readonly<Record<string, string>>): Record<string, string> {
    const own = call.body === undefined ? OWN_HEADERS : [...OWN_HEADERS, ["Content-Type", "application/json"] as const];
    const merged = new Map<string, readonly [string, string]>();
    for (const [name, value] of [...own, ...call.headers, ...Object.entries(signIn)]) {
        merged.set(name.toLowerCase(), [name, value]);
    }
    return Object.fromEntries(merged.values());
}

async function resolveSecret(reference: string, cancel: AbortSignal | undefined): Promise<string> {
    try {
        return await jig().secrets.resolve(reference, cancel);
    } catch (error) {
        throw new NotSentError(`could not sign in (${errorMessage(error)})`);
    }
}

/** The headers a sign-in service supplies for this request. A header it sets cannot also be given by the caller. */
async function signInHeaders(
    call: Call,
    service: string,
    url: string,
    cancel: AbortSignal | undefined,
): Promise<Record<string, string>> {
    let headers: Readonly<Record<string, string>>;
    try {
        headers = await jig().signIn.headers(service, { system: `http:${call.target.name}`, url }, cancel);
    } catch (error) {
        throw new NotSentError(`could not sign in (${errorMessage(error)})`);
    }
    const given = new Set(call.headers.map(([name]) => name.toLowerCase()));
    const clash = Object.keys(headers).find((name) => given.has(name.toLowerCase()));
    if (clash !== undefined) {
        throw new NotSentError(`header ${clash} is set by the sign-in of this target, so it cannot be given`);
    }
    return { ...headers };
}

export function createHttp(options: HttpOptions = {}): Http {
    const timeoutScale = options.timeoutScale ?? 1;
    const tokens = createTokens(options.now ?? Date.now);

    return {
        async send(plan, cancel) {
            const { call } = plan;
            const { target } = call;
            // One deadline for every request the call makes, a token request included. The clock starts with the first
            // request that goes out: a secret store that waits for the user to unlock it is not the API's time.
            const timeoutMs = Math.max(1, Math.round(call.timeoutSec * 1000 * timeoutScale));
            let clock: AbortSignal | undefined;
            const stops: Stops = {
                cancel,
                deadline() {
                    clock ??= AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(cancel === undefined ? [] : [cancel])]);
                    return clock;
                },
            };

            const wire = (signIn: Readonly<Record<string, string>>): Wire => ({
                system: `http:${target.name}`,
                method: call.method,
                url: plan.url,
                headers: headersOf(call, signIn),
                allowPlainLocal: target.allowPlainLocal,
                ...(call.body === undefined ? {} : { body: call.body }),
                ...(target.auth.kind === "transport" ? { transport: target.auth.name } : {}),
            });

            const { auth } = target;
            // What went out as a credential, to remove from the answer.
            const credentials: string[] = [];
            const notes: string[] = [];
            let answer: Answer;
            switch (auth.kind) {
                case "none":
                case "transport":
                    // A transport adds the session itself, and the tool adds nothing.
                    answer = await exchange(wire({}), stops.deadline());
                    break;
                case "bearer": {
                    const secret = await resolveSecret(auth.token, cancel);
                    credentials.push(secret);
                    answer = await exchange(wire({ Authorization: `Bearer ${secret}` }), stops.deadline());
                    break;
                }
                case "signIn": {
                    // Asked for every request: the service decides when its token has expired.
                    const headers = await signInHeaders(call, auth.name, plan.url, cancel);
                    credentials.push(...credentialsOf(headers));
                    answer = await exchange(wire(headers), stops.deadline());
                    break;
                }
                case "oauthPassword": {
                    let token = await tokens.get(target, auth.oauth, stops);
                    credentials.push(token.value);
                    answer = await exchange(wire({ Authorization: `Bearer ${token.value}` }), stops.deadline());
                    if (answer.status === 401 && !token.fresh) {
                        tokens.forget(target);
                        token = await tokens.get(target, auth.oauth, stops);
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
