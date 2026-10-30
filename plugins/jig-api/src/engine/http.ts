// Sending a planned request: the headers, the body, where the sign-in's credential comes from, one exchange, and the answer
// with every credential removed from it.
//
// A saved request signs in with a secret reference, a company sign-in service, a company transport or an OAuth grant. jig-core
// reads the credential and sends the request, so no secret that the sign-in names passes through this file (see wire.ts and
// jig-core's `http.request`). What is filled in here, a secret inside a header or a body, a plain value, a generated one,
// is the request's own text, which this plugin builds.
//
// A request is sent once, and never again after a timeout or a dropped connection: whether a write happened is then
// unknown, and the caller says so (see tool.ts). The one exception is a 401 for an OAuth token that came from the cache,
// which jig-core handles: the server turned the request down because the token has expired, before it acted on it, so
// sending it again with a new token cannot repeat a write.
import { jig } from "../../../jig-core/src/client.ts";
import type { HttpAuth, HttpOAuth, HttpValue } from "../../../jig-core/src/contract.ts";
import { addressProblem } from "./address.ts";
import type { Plan } from "./plan.ts";
import { scrubbed } from "./scrub.ts";
import { fill, fillString, isSecret } from "./text.ts";
import type { Fillers, Text } from "./text.ts";
import { errorMessage } from "./values.ts";
import { exchange, NotSentError } from "./wire.ts";
import type { Answer, Wire } from "./wire.ts";

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

const OWN_HEADERS: Readonly<Record<string, string>> = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": "jig-api",
};

/** The request's headers, then a credential typed in the collection, which replaces the request's of the same name (there
 *  is none: `checkClash` refused it). A credential jig-core reads is added by jig-core, after these. The tool's own
 *  headers are sent as defaults, which both of these replace. */
function mergedHeaders(
    own: ReadonlyArray<readonly [string, string]>,
    signIn: Readonly<Record<string, string>>,
): Record<string, string> {
    const merged = new Map<string, readonly [string, string]>();
    for (const [name, value] of [...own, ...Object.entries(signIn)]) merged.set(name.toLowerCase(), [name, value]);
    return Object.fromEntries(merged.values());
}

/** Fails when the sign-in sets a header that the request has itself: one of the two would silently win. */
function checkClash(own: ReadonlyArray<readonly [string, string]>, signIn: Readonly<Record<string, string>>): void {
    const given = new Set(own.map(([name]) => name.toLowerCase()));
    const clash = Object.keys(signIn).find((name) => given.has(name.toLowerCase()));
    if (clash !== undefined)
        throw new NotSentError(`header ${clash} is set by the sign-in, so the request cannot have it too`);
}

/** The reference of a text that is exactly one secret, written as it is: jig-core reads it, and this plugin never holds the
 *  value. Any other text (plain, mixed, generated, or a secret written into a JSON string or a form) is undefined. */
function referenceOf(text: Text): string | undefined {
    const [piece, ...rest] = text;
    return rest.length === 0 &&
        piece !== undefined &&
        typeof piece === "object" &&
        isSecret(piece) &&
        piece.as === undefined
        ? piece.reference
        : undefined;
}

export function createHttp(options: HttpOptions = {}): Http {
    const timeoutScale = options.timeoutScale ?? 1;
    const now = options.now ?? Date.now;

    return {
        async send(plan, cancel) {
            const timeoutMs = Math.max(1, Math.round(plan.timeoutSec * 1000 * timeoutScale));

            // What went out as a credential through this plugin, to remove from the answer. (What jig-core read for the
            // sign-in is removed from the answer by jig-core.)
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

            // A credential that is a secret reference goes to jig-core as one. One that is typed in the collection, or
            // built from several pieces, is filled here and sent as a header, as the request's own text.
            const literal: Array<readonly [string, string]> = [];
            const oauthValue = async (text: Text): Promise<HttpValue> => {
                const reference = referenceOf(text);
                return reference === undefined ? filled(fillString(text, fillers)) : { ref: reference };
            };
            const { signIn } = plan;
            let auth: HttpAuth | undefined;
            switch (signIn.kind) {
                case "none":
                case "transport":
                    // A transport adds the session itself, and the tool adds nothing.
                    break;
                case "bearer": {
                    const reference = referenceOf(signIn.token);
                    if (reference !== undefined) {
                        auth = { bearer: reference };
                    } else {
                        const token = await filled(fillString(signIn.token, fillers));
                        credentials.push(token);
                        literal.push(["Authorization", `Bearer ${token}`]);
                    }
                    break;
                }
                case "basic": {
                    const reference = referenceOf(signIn.password);
                    const user = await filled(fillString(signIn.username, fillers));
                    if (reference !== undefined) {
                        auth = { basic: { user, password: reference } };
                    } else {
                        const password = await filled(fillString(signIn.password, fillers));
                        const pair = Buffer.from(`${user}:${password}`).toString("base64");
                        credentials.push(pair, password);
                        literal.push(["Authorization", `Basic ${pair}`]);
                    }
                    break;
                }
                case "apiKey": {
                    const reference = referenceOf(signIn.value);
                    if (reference !== undefined) {
                        auth = { header: { name: signIn.name, value: reference } };
                    } else {
                        const key = await filled(fillString(signIn.value, fillers));
                        credentials.push(key);
                        literal.push([signIn.name, key]);
                    }
                    break;
                }
                case "service":
                    // Asked for every request: the service decides when its token has expired.
                    auth = { signIn: signIn.name };
                    break;
                case "oauth": {
                    // The token endpoint is called by jig-core, which applies the same address rules first.
                    const problem = addressProblem(signIn.tokenUrl, plan.allowPlainLocal);
                    if (problem !== undefined) {
                        throw new NotSentError(`could not sign in (the address is refused (${problem}))`);
                    }
                    const grant: HttpOAuth = {
                        grant: signIn.grant,
                        tokenUrl: signIn.tokenUrl,
                        clientId: await oauthValue(signIn.clientId),
                        ...(signIn.clientSecret === undefined
                            ? {}
                            : { clientSecret: await oauthValue(signIn.clientSecret) }),
                        ...(signIn.username === undefined ? {} : { username: await oauthValue(signIn.username) }),
                        ...(signIn.password === undefined ? {} : { password: await oauthValue(signIn.password) }),
                        ...(signIn.scope === undefined ? {} : { scope: signIn.scope }),
                        clientAuth: signIn.clientAuth,
                        // One token per system and environment, as it always was.
                        cache: `${plan.system}/${plan.environment}`,
                    };
                    auth = { oauth: grant };
                    break;
                }
            }

            const literalHeaders = Object.fromEntries(literal);
            checkClash(own, literalHeaders);
            const wire: Wire = {
                system: plan.system,
                method: plan.method,
                url: plan.url,
                headers: mergedHeaders(own, literalHeaders),
                defaultHeaders: OWN_HEADERS,
                allowPlainLocal: plan.allowPlainLocal,
                ...(plan.maxAnswerBytes === undefined ? {} : { maxBytes: plan.maxAnswerBytes }),
                ...(body === undefined ? {} : { body }),
                ...(plan.signIn.kind === "transport" ? { transport: plan.signIn.name } : {}),
                ...(auth === undefined ? {} : { auth }),
            };
            const answer = await exchange(wire, cancel, timeoutMs);
            // A 401 that is left was for a new token: jig-core sends a cached token's 401 again once with a new one.
            if (signIn.kind === "oauth" && answer.status === 401) {
                notes.push("The server rejected a newly issued token: the account may lack access to this path.");
            }
            return { answer: scrubbed(answer, credentials), notes };
        },
    };
}
