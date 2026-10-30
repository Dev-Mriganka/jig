// What the agent may see. An environment has a deny list (everything is readable except what is listed) or an allow list
// (nothing is readable until it is listed), and both reach fields. Three things hold in every environment and cannot be
// configured away: the system databases, `system.*` collections, and field names that look like credentials.
//
// A list is turned into an `Access`. Each call asks it three questions: may this database or collection be used (`namespace`),
// what is the status of a field path (`view().visibility`), and what remains of a result (`view().strip`).
import { isLeaf } from "./bson.ts";
import { InputError, isObject, shortList } from "./values.ts";
import type { Doc } from "./values.ts";

export interface Ns {
    db: string;
    coll: string;
}

/** `yes`: the field is visible. `partial`: part of it is (an allowed `items.sku` makes `items` partial). `no`: it is not. */
export type Visibility = "yes" | "partial" | "no";

const SYSTEM_DATABASES: ReadonlySet<string> = new Set(["admin", "local", "config"]);
/** Field names that look like credentials, in every environment. */
const CREDENTIAL_NAME = /password|secret|token|apikey/i;

export const DATABASE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const COLLECTION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const FIELD_SEGMENT = /^[^\u0000-\u001f\u007f*]{1,128}$/;

export const isCredentialName = (segment: string): boolean => CREDENTIAL_NAME.test(segment);

/** A field path as the access lists see it: array positions and positional operators are not fields. */
export function fieldPath(text: string): string[] {
    return text.split(".").filter((segment) => !/^\d+$/.test(segment) && !/^\$(?:\[[A-Za-z0-9]*\])?$/.test(segment));
}

// ---- the lists ---------------------------------------------------------------------------------------------------------

interface FieldRule {
    /** Absent for `*.field`, which applies to every collection. */
    db?: string;
    coll?: string;
    path: readonly string[];
}

export interface DenyRules {
    databases: ReadonlySet<string>;
    /** `db.collection` */
    collections: ReadonlySet<string>;
    fields: readonly FieldRule[];
}

export type AccessRules =
    | { mode: "deny"; deny: DenyRules; javascript: boolean }
    // `db.collection` to the field paths that may be read.
    | { mode: "allow"; allow: ReadonlyMap<string, readonly (readonly string[])[]>; javascript: boolean };

const fieldPathError = (at: string, text: string): string =>
    `${at}: ${JSON.stringify(text.slice(0, 40))} is not a field path (names joined by dots, no *)`;

/** Reads a deny list. `at` names the key for messages; problems go to `errors`. */
export function readDeny(raw: unknown, at: string, errors: string[]): DenyRules | undefined {
    if (!Array.isArray(raw) || raw.length > 500) {
        errors.push(
            `${at}: must be a list of at most 500 patterns: "db.collection", "db.*", "*.field" or "db.collection.field"`,
        );
        return undefined;
    }
    const databases = new Set<string>();
    const collections = new Set<string>();
    const fields: FieldRule[] = [];
    const before = errors.length;
    for (const entry of raw as unknown[]) {
        const shape = `${at}: ${JSON.stringify(String(entry).slice(0, 40))} is not "db.collection", "db.*", "*.field" or "db.collection.field"`;
        if (typeof entry !== "string") {
            errors.push(shape);
            continue;
        }
        const parts = entry.split(".");
        const [first = "", second = ""] = parts;
        if (parts.length < 2 || parts.some((part) => part === "")) {
            errors.push(shape);
        } else if (first === "*") {
            const path = parts.slice(1);
            if (path.every((part) => FIELD_SEGMENT.test(part))) fields.push({ path });
            else errors.push(fieldPathError(at, entry));
        } else if (!DATABASE_NAME.test(first)) {
            errors.push(shape);
        } else if (parts.length === 2 && second === "*") {
            databases.add(first);
        } else if (parts.length === 2) {
            collections.add(entry);
        } else if (parts.slice(2).every((part) => FIELD_SEGMENT.test(part)) && COLLECTION_NAME.test(second)) {
            fields.push({ db: first, coll: second, path: parts.slice(2) });
            // A collection name may hold dots, so `db.a.b` is also the collection `a.b`. Denying both errs on the safe side.
            collections.add(entry);
        } else {
            errors.push(shape);
        }
    }
    return errors.length > before ? undefined : { databases, collections, fields };
}

/** Reads an allow list: collections mapped to the field paths that may be read. */
export function readAllow(
    raw: unknown,
    at: string,
    errors: string[],
): ReadonlyMap<string, readonly (readonly string[])[]> | undefined {
    if (!isObject(raw) || Object.keys(raw).length === 0 || Object.keys(raw).length > 200) {
        errors.push(
            `${at}: must map 1 to 200 collections to their fields, such as { "orders.orders": ["_id", "status"] }`,
        );
        return undefined;
    }
    const allow = new Map<string, (readonly string[])[]>();
    const before = errors.length;
    for (const [key, list] of Object.entries(raw)) {
        const dot = key.indexOf(".");
        const db = key.slice(0, dot);
        const coll = key.slice(dot + 1);
        if (dot < 1 || !DATABASE_NAME.test(db) || !COLLECTION_NAME.test(coll)) {
            errors.push(`${at}: ${JSON.stringify(key.slice(0, 40))} is not "db.collection"`);
            continue;
        }
        if (!Array.isArray(list) || list.length === 0 || list.length > 500) {
            errors.push(`${at}.${key}: must list 1 to 500 field paths, such as ["_id", "status", "items.sku"]`);
            continue;
        }
        const paths: string[][] = [];
        for (const item of list as unknown[]) {
            const path = typeof item === "string" && item !== "" ? item.split(".") : [];
            if (path.length === 0 || !path.every((part) => FIELD_SEGMENT.test(part) && !part.startsWith("$"))) {
                errors.push(`${at}.${key}: ${JSON.stringify(String(item).slice(0, 40))} is not a field path`);
            } else if (path.some(isCredentialName)) {
                errors.push(
                    `${at}.${key}: ${JSON.stringify(item)} looks like a credential, which is always denied and cannot be allowed`,
                );
            } else {
                paths.push(path);
            }
        }
        allow.set(key, paths);
    }
    return errors.length > before ? undefined : allow;
}

// ---- field paths -------------------------------------------------------------------------------------------------------

const hasPrefix = (path: readonly string[], prefix: readonly string[]): boolean =>
    prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

/** Whether `inner` appears inside `path` as consecutive names, at any depth. */
function containsRun(path: readonly string[], inner: readonly string[]): boolean {
    for (let start = 0; start + inner.length <= path.length; start++) {
        if (inner.every((segment, index) => path[start + index] === segment)) return true;
    }
    return false;
}

/** Whether the end of `path` is the start of `pattern`, so one more name could complete the pattern: `a` ends toward `a.b`. */
function endsTowards(path: readonly string[], pattern: readonly string[]): boolean {
    for (let length = Math.min(path.length, pattern.length - 1); length >= 1; length--) {
        if (path.slice(path.length - length).every((segment, index) => segment === pattern[index])) return true;
    }
    return false;
}

/** Takes credential-like fields out of a value at any depth: all that can be said of a document whose shape is not known. */
export function stripCredentials(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCredentials);
    if (isLeaf(value) || !isObject(value)) return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => !isCredentialName(key))
            .map(([key, item]) => [key, stripCredentials(item)]),
    );
}

// ---- the view of fields ------------------------------------------------------------------------------------------------

/** The fields of the documents of one or more collections, as the lists see them. */
export interface View {
    readonly mode: "deny" | "allow";
    visibility(path: readonly string[]): Visibility;
    /** Whether a single name is denied wherever it appears: a credential name, or a name the deny list gives alone. */
    nameDenied(name: string): boolean;
    /** Why a path is not (fully) visible, for a message. */
    reason(path: readonly string[]): string;
    /** The result without what may not be seen, at any depth. `base` is the path of `value` inside its document. */
    strip(value: unknown, base?: readonly string[]): unknown;
    /** Allow list only: the field paths that may be read. */
    readonly leaves: readonly (readonly string[])[];
}

export interface Access {
    readonly mode: "deny" | "allow";
    /** Whether `$where`, `$function` and `$accumulator` may run (test environments that say so). */
    readonly javascript: boolean;
    /** Throws an InputError naming why a database or collection may not be used. */
    namespace(db: string, coll?: string): void;
    namespaceVisible(db: string, coll?: string): boolean;
    /** The fields of documents from these collections. With an allow list, the first collection's list is used. */
    view(namespaces: readonly Ns[]): View;
    /** Allow list only: the collections of a database that are listed. */
    listed(db: string): string[];
}

/** `db.coll` as the lists name it. */
export const nsName = (ns: Ns): string => `${ns.db}.${ns.coll}`;

export function createAccess(rules: AccessRules): Access {
    const javascript = rules.javascript;

    function visible(db: string, coll: string | undefined): boolean {
        if (SYSTEM_DATABASES.has(db.toLowerCase())) return false;
        if (coll !== undefined && coll.toLowerCase().startsWith("system.")) return false;
        if (rules.mode === "deny") {
            if (rules.deny.databases.has(db)) return false;
            return coll === undefined || !rules.deny.collections.has(`${db}.${coll}`);
        }
        if (coll !== undefined) return rules.allow.has(`${db}.${coll}`);
        return [...rules.allow.keys()].some((key) => key.startsWith(`${db}.`));
    }

    const access: Access = {
        mode: rules.mode,
        javascript,
        namespaceVisible: visible,
        listed: (db) =>
            rules.mode === "allow"
                ? [...rules.allow.keys()]
                      .filter((key) => key.startsWith(`${db}.`))
                      .map((key) => key.slice(db.length + 1))
                : [],

        namespace(db, coll) {
            const name = coll === undefined ? db : `${db}.${coll}`;
            if (SYSTEM_DATABASES.has(db.toLowerCase())) {
                throw new InputError(`${db}: the databases admin, local and config are always denied`);
            }
            if (coll !== undefined && coll.toLowerCase().startsWith("system.")) {
                throw new InputError(`${name}: system collections are always denied`);
            }
            if (visible(db, coll)) return;
            if (rules.mode === "deny") throw new InputError(`${name} is denied by the access list`);
            const names = [...rules.allow.keys()];
            if (names.length === 0)
                throw new InputError(
                    `${name} is not in the allow list: nothing is allowed yet, so add it to the allow list of this environment`,
                );
            throw new InputError(`${name} is not in the allow list; allowed: ${shortList(names, ", ", 90)}`);
        },

        view(namespaces) {
            return createView(rules, namespaces);
        },
    };
    return access;
}

function createView(rules: AccessRules, namespaces: readonly Ns[]): View {
    const deny = rules.mode === "deny" ? rules.deny : undefined;
    const patterns =
        deny === undefined
            ? []
            : deny.fields.filter((rule) =>
                  namespaces.some(
                      (ns) =>
                          (rule.db === undefined || rule.db === ns.db) &&
                          (rule.coll === undefined || rule.coll === ns.coll),
                  ),
              );
    const leaves: readonly (readonly string[])[] =
        rules.mode === "allow" && namespaces[0] !== undefined ? (rules.allow.get(nsName(namespaces[0])) ?? []) : [];
    const manyNames = patterns.filter((rule) => rule.path.length > 1);
    const owner = namespaces[0] === undefined ? "the collection" : nsName(namespaces[0]);

    function visibility(path: readonly string[]): Visibility {
        if (path.some(isCredentialName)) return "no";
        if (rules.mode === "deny") {
            if (patterns.some((rule) => containsRun(path, rule.path))) return "no";
            // A whole document may hold a denied field that can be copied out under another name.
            if (manyNames.some((rule) => path.length === 0 || endsTowards(path, rule.path))) return "partial";
            return "yes";
        }
        if (leaves.some((leaf) => hasPrefix(path, leaf))) return "yes";
        return leaves.some((leaf) => hasPrefix(leaf, path)) ? "partial" : "no";
    }

    return {
        mode: rules.mode,
        leaves,
        visibility,
        nameDenied: (name) =>
            isCredentialName(name) || patterns.some((rule) => rule.path.length === 1 && rule.path[0] === name),

        reason(path) {
            const text = path.join(".");
            const credential = path.find(isCredentialName);
            if (credential !== undefined) {
                return `${JSON.stringify(credential)} looks like a credential (password, secret, token, apiKey), so it is always denied`;
            }
            if (rules.mode === "allow") {
                const listed = leaves.map((leaf) => leaf.join("."));
                const partial = visibility(path) === "partial";
                const lead = partial
                    ? `${JSON.stringify(text)} is only partly allowed in ${owner}`
                    : `${JSON.stringify(text)} is not allowed in ${owner}`;
                return `${lead}; allowed: ${shortList(listed, ", ", 80)}`;
            }
            if (visibility(path) === "partial")
                return `${JSON.stringify(text)} holds a denied field; name the fields you need instead`;
            return `${JSON.stringify(text)} is denied by the access list`;
        },

        strip(value, base = []) {
            const walk = (item: unknown, path: readonly string[]): unknown => {
                if (Array.isArray(item)) return item.map((element) => walk(element, path));
                if (isLeaf(item) || !isObject(item)) return item;
                const kept: [string, unknown][] = [];
                for (const [key, child] of Object.entries(item)) {
                    const next = [...path, key];
                    if (visibility(next) !== "no") kept.push([key, walk(child, next)]);
                }
                return Object.fromEntries(kept);
            };
            return walk(value, base);
        },
    };
}

/**
 * The projection a `find` or `sample` runs with. With an allow list it is an inclusion projection of allowed fields only,
 * whatever was asked: a requested field that is not allowed is refused, and a field that is only partly allowed expands to
 * the allowed fields under it. With a deny list the projection is the one asked for (the result is stripped afterwards).
 */
export function projectionFor(access: Access, ns: Ns, requested: Doc | undefined): Doc | undefined {
    if (access.mode === "deny") return requested;
    const view = access.view([ns]);
    const named = requested === undefined ? [] : Object.entries(requested);
    const included = (flag: unknown): boolean => flag === 1 || flag === true;
    const dropId = requested !== undefined && (requested._id === 0 || requested._id === false);
    if (named.some(([key, flag]) => !included(flag) && !(key === "_id" && dropId))) {
        throw new InputError("name the fields you want with 1; excluding fields is not allowed here");
    }
    const wanted = named.filter(([, flag]) => included(flag)).map(([key]) => fieldPath(key));
    const chosen: string[][] = [];
    if (wanted.length === 0) {
        chosen.push(...view.leaves.map((leaf) => [...leaf]));
    } else {
        for (const path of wanted) {
            const status = view.visibility(path);
            if (status === "no") throw new InputError(`projection: ${view.reason(path)}`);
            if (status === "yes") chosen.push(path);
            else chosen.push(...view.leaves.filter((leaf) => hasPrefix(leaf, path)).map((leaf) => [...leaf]));
        }
    }
    // A path and one of its own children together collide in a projection, so the children go.
    const paths = chosen.filter(
        (path) => !chosen.some((other) => other.length < path.length && hasPrefix(path, other)),
    );
    const projection: Record<string, 0 | 1> = Object.fromEntries(paths.map((path) => [path.join("."), 1 as const]));
    // `_id` comes with an inclusion projection unless it is switched off, so it is switched off when it may not be read.
    if (dropId || view.visibility(["_id"]) === "no") projection._id = 0;
    if (Object.entries(projection).every(([key, flag]) => key === "_id" && flag === 0)) {
        throw new InputError("the projection leaves no field that may be read");
    }
    return projection;
}
