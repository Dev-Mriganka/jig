// Sign-in services: how a company plugin signs requests in to its own systems, such as a single sign-on gateway.
//
// A tool that talks to such a system asks for the headers of one request by the service's name. The values are
// credentials, so they are registered with the redactor before they are returned, exactly as a resolved secret is.
// Every tool result after that is cleaned of them, and an error from here never repeats one.
import type { SignInRequest, SignInService } from "./contract.ts";
import { errorMessage } from "./errors.ts";
import { printable } from "./kit/text.ts";
import type { Redactor } from "./redact.ts";

export interface SignIn {
    register(name: string, service: SignInService): void;
    headers(name: string, request: SignInRequest, signal?: AbortSignal): Promise<Readonly<Record<string, string>>>;
}

export interface SignInOptions {
    /** The redactor that secrets use, so a header value is hidden in the same places a secret is. */
    redactor: Redactor;
}

/** The most registered names an error lists. */
const MAX_NAMES_SHOWN = 10;

/** `Authorization` and `Proxy-Authorization` hold `<scheme> <credential>`. */
const SCHEME_HEADER = /^(?:proxy-)?authorization$/i;

export function createSignIn(options: SignInOptions): SignIn {
    const services = new Map<string, SignInService>();

    /** The headers as a plain copy, or an error that names the service and the header but never a value. */
    function checkHeaders(name: string, value: unknown): Array<[string, string]> {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new TypeError(`sign-in service "${printable(name)}" must return an object of headers`);
        }
        return Object.entries(value).map(([header, headerValue]) => {
            if (typeof headerValue !== "string") {
                const who = `sign-in service "${printable(name)}"`;
                throw new TypeError(`${who} returned a header (${printable(header)}) whose value is not a string`);
            }
            return [header, headerValue];
        });
    }

    function hide(header: string, value: string): void {
        // An empty value protects nothing, and a blank one would blank every space in every result.
        if (value.trim() === "") return;
        options.redactor.register(value);
        // A server may echo the token without the scheme word before it, so the token is hidden on its own too.
        const token = SCHEME_HEADER.test(header) ? /^\S+\s+(\S.*)$/.exec(value)?.[1] : undefined;
        if (token !== undefined) options.redactor.register(token);
    }

    return {
        register(name, service) {
            // A service is code from another package: check its shape here, where the mistake is made.
            if (typeof name !== "string" || name === "") {
                throw new TypeError("signIn.register: the service needs a name");
            }
            if (typeof service?.headers !== "function") {
                throw new TypeError(`signIn.register(${printable(name)}): the service needs a headers function`);
            }
            services.set(name, service);
        },

        async headers(name, request, signal) {
            const service = typeof name === "string" ? services.get(name) : undefined;
            if (service === undefined) {
                const known = [...services.keys()].slice(0, MAX_NAMES_SHOWN).map(printable);
                const registered = known.length === 0 ? "(none are registered)" : `(registered: ${known.join(", ")})`;
                throw new Error(
                    `no sign-in service is named "${printable(String(name))}": ` +
                        `a company plugin registers one with signIn.register ${registered}`,
                );
            }
            const named = (text: unknown) => typeof text === "string" && text !== "";
            if (!named(request?.system) || !named(request.url)) {
                throw new TypeError("signIn.headers: the request needs a system and a url");
            }

            let answer: unknown;
            try {
                answer = await service.headers(request, signal);
            } catch (error) {
                throw new Error(`sign-in service "${printable(name)}" failed: ${errorMessage(error)}`);
            }
            const headers = checkHeaders(name, answer);

            // Registered before they are returned, so they are hidden from this moment on.
            for (const [header, value] of headers) hide(header, value);
            return Object.freeze(Object.fromEntries(headers));
        },
    };
}
