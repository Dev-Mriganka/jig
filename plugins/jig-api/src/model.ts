// What every source turns its files into: saved requests, the environments they run in, and the problems found on the way.
// Nothing here knows a file format. The rest of the plugin (listing, variables, planning, sending) reads only this, so a
// new source needs no change anywhere but its own adapter.
//
// Texts in a request are templates: they may hold `{{name}}` variables, which resolve.ts fills in when the request is run.

/** A text with `{{variables}}` in it. */
export type Template = string;

/** A file a request uploads, named as the request names it. It is only ever read from inside the collection's folder. */
export interface FileRef {
    /** As written: relative to the collection's folder, or absolute. */
    path: string;
}

export type FormField =
    | { kind: "text"; name: string; value: Template; contentType?: string }
    | { kind: "file"; name: string; file: FileRef; filename?: string; contentType?: string };

export type Body =
    /** Text of any kind. `language` says how a value the agent gives is written into it. */
    | { kind: "raw"; text: Template; language?: "xml" | "html" | "text" | "urlencoded" }
    | { kind: "json"; text: Template }
    /** A form: name/value pairs in the URL-encoded form, or parts in the multipart form (which may upload files). */
    | { kind: "form"; encoding: "urlencoded" | "multipart"; fields: readonly FormField[]; boundary?: string }
    /** The whole body is a file. */
    | { kind: "file"; file: FileRef }
    /** A GraphQL operation, sent as a JSON post. */
    | { kind: "graphql"; query: Template; variables?: Template; operationName?: string };

/** How a request signs in, with the same fields as a template. Only forms that need no browser are here. */
export type Auth =
    | { kind: "none" }
    | { kind: "bearer"; token: Template }
    | { kind: "basic"; username: Template; password: Template }
    /** The key goes in a header. A key in the query string is refused by the source: an address ends up in logs. */
    | { kind: "apiKey"; name: Template; value: Template }
    | {
        kind: "oauth2";
        grant: "client_credentials" | "password";
        tokenUrl: Template;
        clientId: Template;
        clientSecret?: Template;
        username?: Template;
        password?: Template;
        scope?: Template;
        clientAuth: "header" | "body";
    };

/** One saved request. */
export interface SavedRequest {
    /** The collection's name in the configuration. */
    collection: string;
    /** The folders it sits in, outermost first. For `.http` files the last one is the file's name. */
    folder: readonly string[];
    name: string;
    /** Where it was read, for messages: the file, and the place in it. */
    origin: string;
    /** Capitals, as written: an unusual one is refused when the request runs. */
    method: string;
    url: Template;
    headers: ReadonlyArray<readonly [name: string, value: Template]>;
    body?: Body;
    auth: Auth;
    /** The variables its texts use, once each, in the order they first appear. A `$name` is a generated value. */
    variables: readonly string[];
    /** The used variables that the collection's environments declare secret. They come from `api.secrets` and nowhere else. */
    secrets: readonly string[];
    /** The used variables that fill a sign-in (an auth field, an `Authorization` header). The agent never gives these. */
    signsIn: readonly string[];
    /** Values only this request has, such as the `@name = value` lines of a `.http` file. They are the weakest. */
    defaults: ReadonlyMap<string, string>;
    /** A script that would have to run before the request. Scripts never run, so such a request is refused. */
    scripts: { prerequest: boolean; /** Whose it is: "the request", "the folder Setup" or "the collection". */ where?: string };
    /** Why the request cannot run at all: a protocol, a method or a sign-in this plugin does not send. */
    unsupported?: string;
    /** Things that do not stop it but that the reader should know, such as a test script that is ignored. */
    notes: readonly string[];
    description?: string;
}

/** A variable of an environment or of a collection. A secret's value is never kept: only the fact that it is one. */
export interface Variable {
    /** Empty for a secret. */
    value: string;
    secret: boolean;
}

export interface Environment {
    name: string;
    /** The file it came from, for messages. */
    file: string;
    variables: ReadonlyMap<string, Variable>;
}

/** Something wrong in a file, found while reading it. Reported by file and by key, and never fatal to the rest. */
export interface Problem {
    file: string;
    /** Where in the file: a JSON path, a variable name or a line. Empty for the file as a whole. */
    key: string;
    message: string;
    level: "warning" | "error";
}

export interface Collection {
    /** The name in the configuration. */
    name: string;
    /** The folder that every file reference must stay inside, after following links. */
    root: string;
    requests: readonly SavedRequest[];
    /** By the name the configuration (or the env file's own name) gives them. */
    environments: ReadonlyMap<string, Environment>;
    /** The collection's own values: weaker than an environment's. */
    variables: ReadonlyMap<string, Variable>;
    /** The sign-in the whole collection sets, for the requests that name none and for an ad-hoc call on this collection. */
    auth: Auth;
    /** Set when that sign-in is one this plugin does not send (Digest, AWS signing, a browser OAuth flow): its name. */
    authRefused?: string;
    problems: readonly Problem[];
}

/** Headers whose values are credentials: the variables in them sign the request in, and the agent never gives them. */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["authorization", "proxy-authorization", "cookie"]);

/** The names that some environment declares secret. */
export function declaredSecrets(environments: Iterable<Environment>): Set<string> {
    const names = new Set<string>();
    for (const environment of environments) {
        for (const [name, variable] of environment.variables) if (variable.secret) names.add(name);
    }
    return names;
}

/** `Orders/Create order` for a request in the folder Orders. */
export function pathOf(request: SavedRequest): string {
    return [...request.folder, request.name].join("/");
}
