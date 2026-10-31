// A sign-in service: the code that signs a request in. A real company puts here whatever its gateway wants: a bearer token from
// a single sign-on tool, an HMAC signature over the method, the path and the body, a cloud signature. A request names the
// service by its name (`auth: { signIn: "acme-sso" }`, or `"signIn": "acme-sso"` in a plugin's section), and jig-core asks for the
// headers of every request, because the service is the one that knows when a token has run out.
//
// This one adds `Authorization: Bearer <token>`. The token is read from a secret reference just before each request, so this file
// never stores it, and jig-core removes the value from every tool result afterwards. It serves Acme's hosts only (see hosts.ts).
import { hostAllowed } from "./hosts.ts";
import type { JigApi, SignInService } from "./jig/types.ts";

export const SSO_SERVICE = "acme-sso";

export interface SsoOptions {
    /** The secret reference to read the token from. Asked for every request, so a change in jig.json applies at once. */
    reference(): string;
    /** Reads a secret reference. jig-core's `secrets.resolve`. */
    resolve(reference: string, signal?: AbortSignal): Promise<string>;
    /** The hosts this service signs in to. */
    hosts: readonly string[];
}

export function createSsoService(options: SsoOptions): SignInService {
    return {
        async headers(request, signal) {
            // The message names no address: it could hold a query.
            if (!hostAllowed(request.url, options.hosts)) throw new Error(`${SSO_SERVICE} signs in to Acme hosts only`);
            const token = await options.resolve(options.reference(), signal);
            return { Authorization: `Bearer ${token}` };
        },
    };
}

export function registerSignIn(api: JigApi, settings: () => { ssoToken: string }, hosts: readonly string[]): void {
    api.signIn.register(
        SSO_SERVICE,
        createSsoService({
            reference: () => settings().ssoToken,
            resolve: (reference, signal) => api.secrets.resolve(reference, signal),
            hosts,
        }),
    );
}
