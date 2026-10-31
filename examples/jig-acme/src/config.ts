// The `acme` section of jig.json: this plugin's own settings, the part that differs from one person to the next. The company
// defaults for other plugins' sections are in defaults/; what only one person can say (their login on the bastion host) is
// here, in a section that jig-core checks when a session starts, so a mistake names its key and the defaults apply.
//
//   {
//     "acme": {
//       "sso":     { "token": "env:ACME_SSO_TOKEN" },
//       "gateway": { "proxy": "http://127.0.0.1:3128" },
//       "bastion": { "user": "jdoe" }
//     }
//   }
//
// Every field is optional. A secret is always a secret reference, never the secret: a value that is not one is refused, and
// the message never repeats it.
import type { JigApi } from "./jig/types.ts";

/** The command Acme's sign-in tool answers to (see secrets.ts). `cmd:` runs the command declared under that name. */
export const DEFAULT_SSO_TOKEN = "cmd:acme-sso";
/** A sign-in proxy on this machine that forwards to Acme's network. */
export const DEFAULT_GATEWAY_PROXY = "http://127.0.0.1:3128";
export const DEFAULT_BASTION_HOST = "bastion.acme.example";

export interface AcmeSettings {
    /** The secret reference the sign-in service reads its token from. */
    ssoToken: string;
    /** The address of the gateway, always on this machine. */
    gatewayProxy: string;
    bastion: {
        host: string;
        /** Your login on the bastion host. Only you know it, so the company cannot default it. */
        user: string | undefined;
    };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** A scheme and a name (`env:ACME_SSO_TOKEN`, `pass:acme/token`). A token pasted here has neither, and is refused. */
const SECRET_REFERENCE = /^[a-z][a-z0-9+.-]*:\S+$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const LOGIN = /^[a-z_][a-z0-9_-]{0,31}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function unknownFields(
    value: Record<string, unknown>,
    known: readonly string[],
    where: string,
    errors: string[],
): void {
    for (const name of Object.keys(value)) {
        if (!known.includes(name)) errors.push(`${where}.${name.slice(0, 40)}: unknown field`);
    }
}

function group(raw: Record<string, unknown>, name: string, known: readonly string[], errors: string[]) {
    const value = raw[name];
    if (value === undefined) return undefined;
    if (!isObject(value)) {
        errors.push(`acme.${name}: must be an object`);
        return undefined;
    }
    unknownFields(value, known, `acme.${name}`, errors);
    return value;
}

/** The error messages for a raw section, for `registerSection`. An empty list means the section is valid. */
export function validateAcme(raw: unknown): string[] {
    if (!isObject(raw)) return ["acme: must be an object"];
    const errors: string[] = [];
    unknownFields(raw, ["sso", "gateway", "bastion"], "acme", errors);

    const sso = group(raw, "sso", ["token"], errors);
    if (sso?.token !== undefined && (typeof sso.token !== "string" || !SECRET_REFERENCE.test(sso.token))) {
        errors.push("acme.sso.token: must be a secret reference such as env:ACME_SSO_TOKEN, never the token itself");
    }

    const gateway = group(raw, "gateway", ["proxy"], errors);
    if (gateway?.proxy !== undefined) {
        const proxy = typeof gateway.proxy === "string" ? proxyOf(gateway.proxy) : undefined;
        if (proxy === undefined) {
            errors.push(
                "acme.gateway.proxy: must be an http address on this machine, such as http://127.0.0.1:3128 " +
                    "(the request is sent in clear text, so the gateway must be local)",
            );
        }
    }

    const bastion = group(raw, "bastion", ["host", "user"], errors);
    if (bastion?.host !== undefined && (typeof bastion.host !== "string" || !HOST.test(bastion.host))) {
        errors.push("acme.bastion.host: must be a host name such as bastion.acme.example");
    }
    if (bastion?.user !== undefined && (typeof bastion.user !== "string" || !LOGIN.test(bastion.user))) {
        errors.push("acme.bastion.user: must be a login name: lower-case letters, digits, _ and -");
    }
    return errors;
}

/** The gateway address as a URL when it is plain http to this machine, else undefined. */
export function proxyOf(address: string): URL | undefined {
    try {
        const url = new URL(address);
        const ok =
            url.protocol === "http:" &&
            LOOPBACK.has(url.hostname) &&
            url.username === "" &&
            url.password === "" &&
            url.search === "" &&
            url.hash === "" &&
            (url.pathname === "/" || url.pathname === "");
        return ok ? url : undefined;
    } catch {
        return undefined;
    }
}

/** The settings as jig-core loaded them, with the defaults for what the section leaves out. */
export function settingsOf(api: JigApi): AcmeSettings {
    const section = api.config.section("acme");
    const raw = isObject(section) ? section : {};
    const field = (name: string): Record<string, unknown> => (isObject(raw[name]) ? raw[name] : {});
    const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
    return {
        ssoToken: text(field("sso").token) ?? DEFAULT_SSO_TOKEN,
        gatewayProxy: text(field("gateway").proxy) ?? DEFAULT_GATEWAY_PROXY,
        bastion: { host: text(field("bastion").host) ?? DEFAULT_BASTION_HOST, user: text(field("bastion").user) },
    };
}
