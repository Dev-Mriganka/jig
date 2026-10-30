// What a field or value is, and which field names mean what. This file is the masking policy for field names:
// results are masked for customer personal data only, and identifiers are never masked.
import { MaskError } from "./error.ts";

/**
 * What a field holds, which decides how its value is masked. `email`, `phone`, `name`, `user`, `personal` and `ip`
 * become tokens, `card` shows its last four digits, and the kinds in REMOVED are dropped. `identifier` and `safe` are
 * kept, but still checked for credential shapes. `other` is scanned as text. `contact` is a `personal` value only where
 * the field holds a scalar (`primaryContact: "Casey Sample"`); where it holds an object the object's own fields decide,
 * so a `billToContact` record keeps its country and its ids.
 */
export type Kind =
    | "email"
    | "phone"
    | "name"
    | "user"
    | "personal"
    | "contact"
    | "card"
    | "cardSecret"
    | "ip"
    | "address"
    | "geo"
    | "government"
    | "bank"
    | "credential"
    | "identifier"
    | "birth"
    | "sensitive"
    | "safe"
    | "other";

/** Judges one field name. `parent` is the name of the enclosing field, which only matters for ambiguous names. */
export type KindOf = (key: string, parent: string) => Kind;

const LABELS: Readonly<Record<Kind, string>> = {
    email: "email",
    phone: "phone",
    name: "name",
    user: "user",
    personal: "personal",
    contact: "personal",
    card: "card",
    cardSecret: "card",
    ip: "ip",
    address: "address",
    geo: "geo",
    government: "government",
    bank: "bank",
    credential: "credential",
    identifier: "id",
    birth: "birth",
    sensitive: "sensitive",
    safe: "other",
    other: "other",
};

/** The category name used in tokens and removal markers. */
export function label(kind: Kind): string {
    return LABELS[kind];
}

/** Kinds whose values are dropped entirely, replaced by a removal marker. */
const REMOVED: ReadonlySet<Kind> = new Set<Kind>([
    "cardSecret",
    "address",
    "geo",
    "government",
    "bank",
    "credential",
    "birth",
    "sensitive",
]);

export function isRemoved(kind: Kind): boolean {
    return REMOVED.has(kind);
}

export function removed(kind: Kind): string {
    return `[removed:${label(kind)}]`;
}

/** Kinds whose non-string scalars (numbers, booleans) are replaced by a token or display form. */
const TOKENISED: ReadonlySet<Kind> = new Set<Kind>(["email", "phone", "name", "user", "personal", "contact", "card"]);

export function isTokenised(kind: Kind): boolean {
    return TOKENISED.has(kind);
}

// ---- field names as words ------------------------------------------------------------------------------------
// Names are judged by their words (`crmAccountId` is crm, account, id), never by substrings of the squashed name
// (where `crmaccountid` contains `mac`). Lowercase compounds (`ipaddress`) are split into the words below.

const COMPOUND_PIECES: ReadonlySet<string> = new Set([
    "email",
    "mail",
    "phone",
    "number",
    "num",
    "address",
    "name",
    "first",
    "last",
    "full",
    "sur",
    "given",
    "family",
    "middle",
    "display",
    "nick",
    "user",
    "username",
    "login",
    "card",
    "bank",
    "account",
    "ip",
    "security",
    "answer",
    "credit",
    "debit",
    "payment",
    "holder",
    "date",
    "of",
    "birth",
    "tax",
    "id",
    "government",
    "social",
    "api",
    "key",
    "password",
    "passwd",
    "passphrase",
    "passport",
    "secret",
    "token",
    "access",
    "refresh",
    "client",
    "source",
    "peer",
    "remote",
    "license",
    "licence",
    "driver",
    "routing",
    "street",
    "postal",
    "code",
    "zip",
    "city",
    "line",
    "calling",
    "called",
    "health",
    "note",
    "device",
    "contact",
    "billing",
    "shipping",
    "mailing",
    "work",
    "home",
    "service",
    "customer",
    "primary",
    "caller",
    "fax",
    "sms",
    "mobile",
    "cell",
    "did",
    "dialed",
    "dialable",
    "destination",
    "originating",
    "ported",
    "porting",
    "sip",
    "uri",
    "admin",
    "technical",
]);

/** Splits a lowercase run such as `ipaddress` into known words; anything else stays whole. */
function segment(token: string): string[] {
    if (token.length < 6 || COMPOUND_PIECES.has(token)) return [token];
    const best: Array<string[] | undefined> = new Array(token.length + 1);
    best[0] = [];
    for (let end = 1; end <= token.length; end++) {
        for (let start = Math.max(0, end - 10); start < end; start++) {
            const head = best[start];
            if (head === undefined || !COMPOUND_PIECES.has(token.slice(start, end))) continue;
            const current = best[end];
            if (current === undefined || head.length + 1 < current.length) {
                best[end] = [...head, token.slice(start, end)];
            }
        }
    }
    const pieces = best[token.length];
    return pieces !== undefined && pieces.length > 1 ? pieces : [token];
}

/** Lowercase words of a field name; digits are dropped (`line1` is `line`, `sourceIPv6` is `source`, `ipv`). */
function words(name: string): string[] {
    const tokens = name.replace(/IPv([46])/gi, "Ipv$1").match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [];
    return tokens.filter((token) => !/^[0-9]+$/.test(token)).flatMap((token) => segment(token.toLowerCase()));
}

/** Lowercase letters and digits only, for the exact-name lists. */
function squash(text: string): string {
    return text.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

// Diagnostic fields that carry no personal data, never scanned. Only exact names, never a prefix or suffix.
const SAFE_FIELDS: ReadonlySet<string> = new Set([
    "accountid",
    "accountnumber",
    "orderid",
    "invoiceid",
    "callid",
    "traceid",
    "spanid",
    "sku",
    "productname",
    "companyname",
    "version",
    "build",
    "timestamp",
    "createdat",
    "starttime",
    "status",
    "durationseconds",
    "totaldurationseconds",
    "totalcalls",
]);

// Telephony names for a number. These are matched as the whole field name, because each is too short, or too common as a
// word, to be matched inside a longer name (`cell` alone is a number, `cellTower` is not; `client` is not `cli`).
const NUMBER_NAMES: ReadonlySet<string> = new Set([
    "tn",
    "did",
    "called",
    "ani",
    "dnis",
    "cli",
    "btn",
    "fax",
    "mobile",
    "cell",
]);
// A word that makes `...Number` a telephone number: `faxNumber`, `callerNumber`, `destinationNumber`, `contactNumber`.
const NUMBER_QUALIFIERS: ReadonlySet<string> = new Set([
    "calling",
    "called",
    "caller",
    "fax",
    "sms",
    "mobile",
    "cell",
    "did",
    "dialed",
    "dialable",
    "contact",
    "destination",
    "originating",
    "ported",
    "porting",
    "ani",
    "dnis",
    "cli",
    "btn",
]);

// Identifiers are kept readable so tickets stay debuggable, but are still checked for credential shapes.
const IDENTIFIER_SUFFIXES: ReadonlySet<string> = new Set(["id", "ids", "uuid", "guid", "oid"]);
const DEVICE_WORDS = ["mac", "imei", "iccid", "imsi", "meid", "esn"];

// A trailing word that says the field describes a value rather than holding one: `phoneType`, `emailVerified`,
// `passwordLength`, `userNameFormat`.
const DESCRIPTORS: ReadonlySet<string> = new Set([
    "format",
    "formats",
    "type",
    "types",
    "kind",
    "count",
    "counts",
    "total",
    "flag",
    "enabled",
    "disabled",
    "verified",
    "validated",
    "valid",
    "confirmed",
    "required",
    "version",
    "length",
    "size",
    "pattern",
    "regex",
    "label",
    "status",
    "mode",
    "policy",
    "schema",
    "provider",
    "rate",
    "limit",
    "max",
    "min",
    "date",
    "time",
    "timestamp",
    "at",
]);

// With `name`, these say the field names a thing, not a person (`hostName`, `serviceName`, `bankName`). Account and
// location names are business names; `customerName` and contact names stay masked. The same words, as the enclosing
// field, say that a bare `name` inside it names a thing too (`plans[].name`, `products[].name`).
const NOT_A_PERSON: readonly string[] = [
    "company",
    "account",
    "location",
    "product",
    "service",
    "host",
    "file",
    "class",
    "table",
    "column",
    "field",
    "queue",
    "topic",
    "package",
    "app",
    "application",
    "plan",
    "carrier",
    "brand",
    "model",
    "index",
    "cluster",
    "node",
    "pod",
    "container",
    "job",
    "task",
    "event",
    "api",
    "endpoint",
    "domain",
    "env",
    "environment",
    "region",
    "org",
    "organization",
    "tenant",
    "bank",
    "schema",
    "tag",
    "label",
    "key",
    "method",
    "path",
    "type",
    "script",
    "process",
    "rule",
    "template",
    "workflow",
    "flow",
    "route",
    "device",
    "interface",
    "group",
    "role",
    "zone",
    "site",
    "trunk",
    "feature",
    "metric",
    "logger",
    "thread",
    "cache",
    "database",
    "bucket",
    "stage",
    "step",
    "sheet",
    "report",
    "view",
    "page",
];
// More enclosing fields whose bare `name` names a thing (`charges[].name`). Kept apart from the list above because a
// word of that list hides a person's name anywhere in a field name (`rateContactName`), which is a cost worth paying
// only for words that are common.
const THING_PARENTS: readonly string[] = ["charge", "trigger", "sku", "catalog", "rate", "amendment"];
const NETWORK_WORDS = [
    "remote",
    "client",
    "source",
    "src",
    "peer",
    "dest",
    "destination",
    "host",
    "server",
    "proxy",
    "forwarded",
];
// An expiry that belongs to something other than a payment card.
const NOT_CARD_EXPIRY = [
    "subscription",
    "contract",
    "trial",
    "promo",
    "offer",
    "license",
    "licence",
    "token",
    "session",
    "cert",
    "certificate",
    "password",
    "key",
    "order",
    "quote",
    "invoice",
    "plan",
    "service",
    "support",
    "account",
];

const cache = new Map<string, Kind>();
const CACHE_LIMIT = 4_096;

/**
 * Classifies a field name by the built-in rules. `parent` is the name of the enclosing field, which only matters for
 * ambiguous names (`from`/`to` inside `cdr`/`usage`, `account` inside `bank`). The first matching rule wins:
 * identifiers first, then the personal-data kinds. Names repeat a lot in one result, hence the cache.
 */
export function fieldKind(key: string, parent: string): Kind {
    const cacheKey = `${parent}\0${key}`;
    let kind = cache.get(cacheKey);
    if (kind === undefined) {
        kind = classify(key, parent);
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(cacheKey, kind);
    }
    return kind;
}

function lastSegment(key: string): string {
    return key.slice(key.lastIndexOf(".") + 1);
}

/**
 * The classifier of one masker. `extraFields` are names a company adds to the personal-data fields. They are compared
 * like the built-in exact-name lists, ignoring case and separators (`subscriberAlias` also matches `subscriber_alias`),
 * and they win over every built-in rule, because an explicit entry can only mean "mask this".
 */
export function createClassifier(extraFields: readonly string[] = []): KindOf {
    // A bare string would iterate as single letters, and silently protect the wrong fields.
    if (!Array.isArray(extraFields)) throw new MaskError("masking failed: extra field names must be a list");
    const extra = new Set<string>();
    for (const name of extraFields) {
        const squashed = typeof name === "string" ? squash(name) : "";
        // Failing here, at start-up, beats silently leaving a field the company meant to protect in the clear.
        if (squashed === "") throw new MaskError("masking failed: an extra field name has no letters or digits");
        extra.add(squashed);
    }
    if (extra.size === 0) return fieldKind;
    return (key, parent) => (extra.has(squash(lastSegment(key))) ? "personal" : fieldKind(key, parent));
}

function classify(key: string, parent: string): Kind {
    const name = lastSegment(key);
    const joined = squash(name);
    const w = words(name);
    const last = w[w.length - 1] ?? "";
    const parentWords = words(parent);
    const has = (...needles: string[]): boolean => needles.some((needle) => w.includes(needle));
    const sequence = (first: string, second: string): boolean =>
        w.some((word, i) => word === first && w[i + 1] === second);
    const value = !DESCRIPTORS.has(last); // false for `phoneType`, `emailVerified`, ...
    // In a call or usage record, `from` and `to` are the two numbers.
    const callRecord = squash(parent) === "cdr" || squash(parent) === "usage";

    if (key === "_id" || key === "$oid") return "identifier";
    if (parentWords.includes("bank") && (joined === "account" || joined === "accountnumber")) return "bank";
    if (SAFE_FIELDS.has(joined)) return "safe";
    if (has(...DEVICE_WORDS) || sequence("device", "id")) return "identifier";

    if (value && (has("email", "emails") || sequence("e", "mail") || last === "mail")) return "email";
    // `faxNumber`, `callerNumber`: a telephony word, then "number". `tnList` and `portingTn` hold telephone numbers too.
    const numbered = w.some(
        (word, i) => (word === "number" || word === "num") && NUMBER_QUALIFIERS.has(w[i - 1] ?? ""),
    );
    // `callerId` is a number although it ends in `id`; `callerIdName` is a name, and the name rule below has it.
    const callerId = sequence("caller", "id") && (last === "id" || last === "number" || last === "num");
    if (
        value &&
        (has("phone", "phones", "telephone", "msisdn", "tn", "tns") ||
            NUMBER_NAMES.has(joined) ||
            numbered ||
            callerId ||
            (callRecord && (joined === "from" || joined === "to")))
    )
        return "phone";
    // A SIP address names a person or a line; it is not a bare number, so it is a token and not a phone.
    if (value && sequence("sip", "uri")) return "personal";
    // `contact`, `billToContact`: a person or a line, when the field holds a scalar (see Kind).
    if (value && last === "contact") return "contact";
    if (value && (has("username", "login", "logins") || sequence("user", "name"))) return "user";
    if (value && (sequence("tax", "id") || sequence("government", "id"))) return "government";
    if (IDENTIFIER_SUFFIXES.has(last)) return "identifier";

    if (value && (has("ip", "ips", "ipv") || (last === "address" && NETWORK_WORDS.some((word) => w.includes(word))))) {
        return "ip";
    }
    if (
        value &&
        (/^(?:credit|debit|payment)?card(?:number|num|no)?$/.test(joined) ||
            joined === "pan" ||
            joined === "pannumber" ||
            sequence("card", "number") ||
            sequence("card", "num"))
    )
        return "card";
    if (has("cvv", "cvc", "cvv2", "cvc2") || (has("expiry", "expiration") && !has(...NOT_CARD_EXPIRY))) {
        return "cardSecret";
    }
    if (
        value &&
        (has(
            "password",
            "passwd",
            "pwd",
            "passphrase",
            "secret",
            "secrets",
            "token",
            "tokens",
            "authorization",
            "apikey",
            "credential",
            "credentials",
            "pin",
            "pincode",
        ) ||
            sequence("api", "key") ||
            sequence("security", "answer"))
    )
        return "credential";
    if (
        has("health", "biometric", "biometrics", "demographic", "demographics") &&
        !has("check", "checks", "endpoint", "probe", "url", "path")
    )
        return "sensitive";
    if (has("dob", "birth", "birthday", "birthdate")) return "birth";
    if (
        has("ssn", "itin", "ein", "passport", "passports") ||
        sequence("social", "security") ||
        (value && has("license", "licence") && last !== "state")
    )
        return "government";
    if (joined === "iban" || has("iban", "routing") || sequence("bank", "account")) return "bank";
    if (has("latitude", "longitude", "lat", "lon", "lng", "gps", "geo", "geolocation", "coordinate", "coordinates")) {
        return "geo";
    }
    if (
        value &&
        (has("address", "addresses", "street", "streets", "postal", "postcode", "zip", "zipcode", "city") ||
            joined === "line1" ||
            joined === "line2" ||
            joined === "unit")
    )
        return "address";
    // A bare `name` takes its meaning from the parent: `plans[].name` or `charges[].name` name things.
    const isThing = (word: string): boolean => NOT_A_PERSON.includes(word) || THING_PARENTS.includes(word);
    const namesAThing = w.length === 1 && parentWords.some((p) => isThing(p) || isThing(p.replace(/s$/, "")));
    if (value && has("name", "names") && !has(...NOT_A_PERSON) && !namesAThing) return "name";
    return "other";
}
