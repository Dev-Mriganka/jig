// The OAuth 2.0 password grant (RFC 6749, section 4.3): the tool trades an account's name and password for an access
// token, keeps the token in memory until shortly before it expires, and sends it as a Bearer token.
//
// The token is never written anywhere, never logged and never put in a result or an error. jig-core cannot hide it, because
// it did not resolve it, so http.ts removes it from every answer (see scrub.ts). Every failure here is a NotSentError:
// whether or not the token endpoint got the request, nothing has gone to the API yet.
import { jig } from "../../jig-core/src/client.ts";
import type { OAuthPassword, Target } from "./config.ts";
import { errorMessage, isObject } from "./values.ts";
import { exchange, LostReplyError, NotSentError } from "./wire.ts";
import type { Answer, Stops, Wire } from "./wire.ts";

/** A token is replaced this long before it expires, so that it does not run out on the way. */
export const REPLACE_EARLY_MS = 60_000;
/** A token answer is small. A longer one is not read. */
const MAX_TOKEN_ANSWER_BYTES = 64 * 1024;
/** What a token is: printable characters without a space, so that it can go into a header. */
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
/** The error codes of RFC 6749, section 5.2: the only words of the endpoint's answer that are repeated. */
const OAUTH_ERRORS: ReadonlySet<string> = new Set([
    "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope",
]);

export interface Token {
    value: string;
    /** False when the token came from the cache, so it may have expired or been revoked since. */
    fresh: boolean;
}

export interface Tokens {
    /** The target's access token: the cached one while it is good, else a new one. */
    get(target: Target, oauth: OAuthPassword, stops: Stops): Promise<Token>;
    /** Drops the target's cached token, such as after a 401. */
    forget(target: Target): void;
}

interface Cached {
    /** The sign-in settings the token was made with. Other settings need another token. */
    key: string;
    value: string;
    /** When the token expires, in the clock's milliseconds. Infinity when the endpoint did not say. */
    expiresAt: number;
}

/** The account the grant signs in with, as the secrets gave it. */
interface Account {
    username: string;
    password: string;
    clientSecret: string | undefined;
}

/** The text in the form of `application/x-www-form-urlencoded`. */
const formEncoded = (text: string): string => new URLSearchParams({ v: text }).toString().slice(2);

function refused(why: string): NotSentError {
    return new NotSentError(`could not sign in (${why})`);
}

/** What the endpoint said was wrong, when it said it in the words of the standard. */
function oauthErrorOf(answer: Answer): string {
    try {
        const data: unknown = JSON.parse(answer.text);
        return isObject(data) && typeof data.error === "string" && OAUTH_ERRORS.has(data.error) ? data.error : "";
    } catch {
        return "";
    }
}

/** How long the token lives, as a time on the clock; Infinity when `expires_in` is missing or not a positive number. */
function expiryOf(data: Record<string, unknown>, now: number): number {
    const given = data.expires_in;
    const seconds = typeof given === "string" && /^\d{1,9}$/.test(given) ? Number(given) : given;
    const valid = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
    return valid ? now + seconds * 1000 : Number.POSITIVE_INFINITY;
}

/** The grant, as the form the token endpoint takes. A client with a secret signs in with HTTP Basic. */
function tokenRequest(target: Target, oauth: OAuthPassword, account: Account): Wire {
    const form = new URLSearchParams({
        grant_type: "password",
        username: account.username,
        password: account.password,
        client_id: oauth.clientId,
    });
    if (oauth.scope !== undefined) form.set("scope", oauth.scope);
    const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "jig-http",
    };
    if (account.clientSecret !== undefined) {
        // RFC 6749, section 2.3.1: the client's id and secret are form-encoded before they are joined.
        const pair = `${formEncoded(oauth.clientId)}:${formEncoded(account.clientSecret)}`;
        headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    }
    return {
        system: `http:${target.name}`,
        method: "POST",
        url: oauth.tokenUrl,
        headers,
        body: form.toString(),
        allowPlainLocal: target.allowPlainLocal,
        maxBytes: MAX_TOKEN_ANSWER_BYTES,
    };
}

/** The token in the endpoint's answer, or a NotSentError that says what was wrong with the answer. */
function tokenFrom(answer: Answer, now: number): { value: string; expiresAt: number } {
    if (answer.status !== 200) {
        const code = oauthErrorOf(answer);
        throw refused(`the token endpoint answered HTTP ${answer.status}${code === "" ? "" : `, ${code}`}`);
    }
    let data: unknown;
    try {
        data = answer.cut ? undefined : JSON.parse(answer.text);
    } catch {
        data = undefined;
    }
    const token = isObject(data) ? data.access_token : undefined;
    if (!isObject(data) || typeof token !== "string" || !TOKEN.test(token)) {
        throw refused("the token endpoint answered without a usable access_token");
    }
    if (data.token_type !== undefined && String(data.token_type).toLowerCase() !== "bearer") {
        // The endpoint's own word for the type is not repeated: it is text from outside.
        throw refused(
            "the token endpoint answered with a token that is not a bearer token, and only bearer tokens are sent",
        );
    }
    return { value: token, expiresAt: expiryOf(data, now) };
}

export function createTokens(now: () => number): Tokens {
    const cache = new Map<string, Cached>();

    /** Asks the token endpoint for a token. */
    async function login(target: Target, oauth: OAuthPassword, stops: Stops): Promise<{ value: string; expiresAt: number }> {
        // Only the user's cancel applies while the secrets are read: a store may wait for the user to unlock it.
        const secret = (reference: string): Promise<string> => jig().secrets.resolve(reference, stops.cancel);
        let account: Account;
        try {
            const [username, password, clientSecret] = await Promise.all([
                secret(oauth.username),
                secret(oauth.password),
                oauth.clientSecret === undefined ? undefined : secret(oauth.clientSecret),
            ]);
            account = { username, password, clientSecret };
        } catch (error) {
            throw refused(errorMessage(error));
        }

        let answer: Answer;
        try {
            answer = await exchange(tokenRequest(target, oauth, account), stops.deadline());
        } catch (error) {
            if (error instanceof LostReplyError) throw refused(`the token request got no answer: ${error.message}`);
            throw refused(errorMessage(error));
        }
        return tokenFrom(answer, now());
    }

    return {
        async get(target, oauth, stops) {
            const { tokenUrl, clientId, clientSecret, username, password, scope } = oauth;
            const key = JSON.stringify([tokenUrl, clientId, clientSecret, username, password, scope]);
            const kept = cache.get(target.name);
            if (kept !== undefined && kept.key === key && now() < kept.expiresAt - REPLACE_EARLY_MS) {
                return { value: kept.value, fresh: false };
            }
            const made = await login(target, oauth, stops);
            cache.set(target.name, { key, ...made });
            return { value: made.value, fresh: true };
        },

        forget(target) {
            cache.delete(target.name);
        },
    };
}
