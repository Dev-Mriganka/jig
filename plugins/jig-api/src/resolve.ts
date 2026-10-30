// Filling in `{{variables}}`. A request's texts name variables; this decides what each one is, in this order:
//   1. the values the agent gave, only for variables the request itself uses, and never for a secret or a sign-in;
//   2. the environment's values, then the request's own values (a `.http` file's `@name = value`), then the collection's;
//   3. secrets, which come from `api.secrets` references and from nowhere else.
// A variable with no value is invalid input and is named.
//
// What the agent gives is written into the text it lands in so that it stays a value and cannot become structure: percent-
// encoded in an address or a URL-encoded form, escaped in a JSON string or in XML, held to a plain token in a GraphQL query,
// held to printable characters in a header. And it can never reach the host: a variable in the host part of an address is
// refused if the agent gave it. Values from the environment are the team's own and are written as they are.
import { generatedKind, partsOf } from "./template.ts";
import type { SecretSource } from "./config.ts";
import { joined } from "./engine/text.ts";
import type { Piece, Text } from "./engine/text.ts";
import { InputError, shortList } from "./engine/values.ts";
import type { Collection, Environment, SavedRequest } from "./model.ts";

/** Where a text will sit, which decides how a value from the agent is written into it. */
export type Slot = "plain" | "header" | "json" | "form" | "xml" | "graphql";

const MAX_VALUE_CHARS = 2000;
const MAX_DEPTH = 8;
/** C0 controls other than tab, line feed and carriage return. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const JSON_SCALAR = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/;
/** What may stand in for a name or a number in a GraphQL query: no braces, quotes or punctuation that is syntax. */
const GRAPHQL_TOKEN = /^[A-Za-z0-9_.:@+\- ]{0,200}$/;

export interface ScopeInput {
    collection: Collection;
    environment: Environment;
    /** The collection's name for the environment, which `api.secrets` may key a reference by. */
    label: string;
    /** The request whose texts these are. Undefined for the collection's own, such as its sign-in. */
    request: SavedRequest | undefined;
    secrets: ReadonlyMap<string, SecretSource>;
    /** Already checked by `agentValues`. */
    agent: ReadonlyMap<string, string>;
}

/** The names that are secrets for this collection: declared so in any of its environments, or given in `api.secrets`. */
export function secretNamesOf(collection: Collection, secrets: ReadonlyMap<string, SecretSource>): Set<string> {
    const names = new Set(secrets.keys());
    for (const environment of collection.environments.values()) {
        for (const [name, variable] of environment.variables) if (variable.secret) names.add(name);
    }
    for (const request of collection.requests) for (const name of request.secrets) names.add(name);
    return names;
}

/**
 * The values the agent gave, checked: each must be a variable the request uses, and not a secret or a sign-in. Everything
 * else about a value is checked where it is written.
 */
export function agentValues(
    request: SavedRequest,
    given: Readonly<Record<string, unknown>> | undefined,
    secretNames: ReadonlySet<string>,
): Map<string, string> {
    const values = new Map<string, string>();
    if (given === undefined || given === null) return values;
    const uses = request.variables.filter((name) => !name.startsWith("$"));
    for (const [name, value] of Object.entries(given)) {
        if (value === undefined || value === null) continue;
        if (!request.variables.includes(name) || name.startsWith("$")) {
            const list = uses.length === 0 ? "it uses none" : `it uses ${shortList(uses, ", ", 70)}`;
            throw new InputError(`${JSON.stringify(name)} is not a variable of ${request.name}; ${list}`);
        }
        if (secretNames.has(name) || request.secrets.includes(name) || request.signsIn.includes(name)) {
            throw new InputError(`${name} is a secret or fills the sign-in, so it comes from the environment and api.secrets, not from the call`);
        }
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
            throw new InputError(`the value of ${name} must be text, a number or true or false`);
        }
        const text = String(value);
        if (text.length > MAX_VALUE_CHARS || CONTROL.test(text)) {
            throw new InputError(`the value of ${name} must be at most ${MAX_VALUE_CHARS} characters with no control characters`);
        }
        values.set(name, text);
    }
    return values;
}

function escapeXml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] as string);
}

/** Whether the position after `chunk` is inside a JSON string, given whether the position before it was. */
function insideString(was: boolean, chunk: string): boolean {
    let inside = was;
    for (let index = 0; index < chunk.length; index++) {
        if (inside && chunk[index] === "\\") index++;
        else if (chunk[index] === '"') inside = !inside;
    }
    return inside;
}

/** A value of the agent's, written for the slot it lands in. */
function written(name: string, value: string, slot: Slot, inString: boolean): string {
    switch (slot) {
        case "plain":
            return value;
        case "header":
            if (!/^[\x20-\x7e]*$/.test(value)) throw new InputError(`the value of ${name} goes into a header, so it must be printable ASCII`);
            return value;
        case "form":
            return encodeURIComponent(value);
        case "xml":
            return escapeXml(value);
        case "json":
            if (inString) return JSON.stringify(value).slice(1, -1);
            if (!JSON_SCALAR.test(value)) {
                throw new InputError(`${name} sits outside a string in a JSON body, so its value must be a number, true, false or null`);
            }
            return value;
        case "graphql":
            if (!GRAPHQL_TOKEN.test(value)) {
                throw new InputError(
                    `${name} goes into a GraphQL query, so its value must be letters, digits and _ . : @ + - only; ` +
                        "use a GraphQL variable for anything else",
                );
            }
            return value;
    }
}

/** How a secret is written where it sits. */
function secretAs(slot: Slot, inString: boolean): "json" | "form" | undefined {
    if (slot === "json" && inString) return "json";
    return slot === "form" ? "form" : undefined;
}

/** The start of an address: the scheme and the host, up to where the path, the query or the fragment begins. */
function originEnd(url: string): number {
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
    if (scheme === null) return -1;
    const stop = url.slice(scheme[0].length).search(/[/?#]/);
    return stop < 0 ? url.length : scheme[0].length + stop;
}

/** Where one variable's text stands in an address, and whether the agent gave it. */
interface Span {
    name: string;
    start: number;
    end: number;
    agent: boolean;
}

export interface Address {
    url: string;
    /** `https://host:port`. */
    origin: string;
    /** True when a variable stands in the scheme or the host, so that the environment decides where the request goes. */
    fromVariables: boolean;
}

export interface Resolver {
    /** A text for a header, a body or a sign-in. */
    text(template: string, slot: Slot): Text;
    /** The address, with the agent's values encoded and none of them in the host. */
    address(template: string): Address;
    /** The scheme and host only, or undefined if they cannot be worked out here. For finding an environment's hosts. */
    origin(template: string): Address | undefined;
    /** Throws the variables that had no value and the secrets that have no reference, all at once. */
    finish(): void;
}

export function createResolver(input: ScopeInput): Resolver {
    const { collection, environment, label, request, secrets, agent } = input;
    const secretNames = secretNamesOf(collection, secrets);
    const missing = new Set<string>();
    const unreferenced = new Set<string>();

    const referenceOf = (name: string): string | undefined => {
        const source = secrets.get(name);
        return source?.byEnvironment.get(label) ?? source?.everywhere;
    };

    /** The value of a variable the team defines: the environment's, then the request's own, then the collection's. */
    const defined = (name: string): string | undefined =>
        environment.variables.get(name)?.value ?? request?.defaults.get(name) ?? collection.variables.get(name)?.value;

    /** One variable, as the pieces it stands for. `top` is true for a variable the request's own text names. */
    function variable(name: string, top: boolean, slot: Slot, inString: boolean, stack: readonly string[]): { pieces: Piece[]; agent: boolean } {
        if (name.startsWith("$")) {
            const generated = generatedKind(name);
            if (generated === undefined) {
                throw new InputError(`{{${name}}} is not supported (only $uuid, $timestamp and $isoTimestamp are made here)`);
            }
            return { pieces: [{ generated }], agent: false };
        }
        if (secretNames.has(name)) {
            const reference = referenceOf(name);
            if (reference === undefined) {
                unreferenced.add(name);
                return { pieces: [], agent: false };
            }
            const as = secretAs(slot, inString);
            return { pieces: [{ secret: name, reference, ...(as === undefined ? {} : { as }) }], agent: false };
        }
        if (top && agent.has(name)) return { pieces: [written(name, agent.get(name) as string, slot, inString)], agent: true };

        const value = defined(name);
        if (value === undefined) {
            missing.add(name);
            return { pieces: [], agent: false };
        }
        if (stack.includes(name) || stack.length >= MAX_DEPTH) throw new InputError(`${name} refers to itself`);
        return { pieces: [...expand(value, false, slot, inString, [...stack, name])], agent: false };
    }

    /** A template's texts and variables, in order. */
    function expand(template: string, top: boolean, slot: Slot, inString: boolean, stack: readonly string[]): Text {
        const pieces: Piece[] = [];
        let inside = inString;
        for (const part of partsOf(template)) {
            if (typeof part === "string") {
                pieces.push(part);
                if (top && slot === "json") inside = insideString(inside, part);
            } else {
                pieces.push(...variable(part.variable, top, slot, inside, stack).pieces);
            }
        }
        return joined(pieces);
    }

    /** The pieces of an address, with where the agent's values stand. */
    function walkAddress(template: string, onlyOrigin: boolean): { text: string; spans: Span[] } {
        let text = "";
        const spans: Span[] = [];
        for (const part of partsOf(template)) {
            if (typeof part === "string") {
                text += part;
            } else {
                const found = variable(part.variable, true, "plain", false, []);
                const start = text.length;
                for (const piece of found.pieces) {
                    if (typeof piece !== "string") {
                        throw new InputError(
                            `${part.variable} is a secret or a generated value, and an address would show it: send it in a header or the body`,
                        );
                    }
                    // The agent's value is written for an address; a team's own value is written as it is.
                    text += found.agent ? encodeURIComponent(piece) : piece;
                }
                if (found.agent && /^\.{1,2}$/.test(text.slice(start))) throw new InputError(`${part.variable} cannot be . or .. in an address`);
                spans.push({ name: part.variable, start, end: text.length, agent: found.agent });
            }
            if (onlyOrigin && originEnd(text) >= 0 && /[/?#]/.test(text.slice(text.indexOf("://") + 3))) break;
        }
        return { text, spans };
    }

    function addressOf(template: string, onlyOrigin: boolean): Address | undefined {
        const { text, spans } = walkAddress(template, onlyOrigin);
        const end = originEnd(text);
        // Without a scheme the start of the text is the scheme and host, up to the first place the path could begin.
        const stop = end >= 0 ? end : text.search(/[/?#]/) >= 0 ? text.search(/[/?#]/) : text.length;
        const onHost = spans.find((span) => span.agent && span.start < stop);
        if (onHost !== undefined) {
            throw new InputError(`${onHost.name} would set the host of the request: the host comes from the environment, not from the call`);
        }
        if (end < 0) {
            if (onlyOrigin) return undefined;
            const starts = JSON.stringify(text.slice(0, 30));
            throw new InputError(`the address must start with https:// (or http://) once its variables are filled in; it starts ${starts}`);
        }
        return { url: text, origin: text.slice(0, end), fromVariables: spans.some((span) => span.start < end) };
    }

    return {
        text: (template, slot) => expand(template, true, slot, false, []),
        address: (template) => addressOf(template, false) as Address,
        origin(template) {
            const before = missing.size;
            const found = addressOf(template, true);
            // A variable that is missing in the host part means the host is not known here. One in the path does not matter.
            if (found !== undefined && missing.size === before) return found;
            return undefined;
        },
        finish() {
            if (unreferenced.size > 0) {
                const names = [...unreferenced];
                const one = names.length === 1;
                throw new InputError(
                    `${shortList(names, ", ", 60)} ${one ? "is a secret" : "are secrets"}, ` +
                        `but api.secrets has no reference for ${one ? "it" : "them"} in ${label}`,
                );
            }
            if (missing.size > 0) {
                throw new InputError(
                    `no value for ${shortList([...missing], ", ", 60)} in ${label}: ` +
                        "pass the ones the request uses in variables, or define them in the environment",
                );
            }
        },
    };
}
