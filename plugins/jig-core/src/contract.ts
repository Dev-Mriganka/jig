// The contract between jig-core and every other plugin.
//
// Plugins import these types with `import type` only, and reach jig-core at run time through `jig()` in
// client.ts. They never import jig-core's modules: Pi gives each installed package its own module root, so a
// company plugin cannot share jig-core's module instances (Pi's docs/packages.md, "Declare dependencies").

/** Where a call acts. `local`, `external` and `production` are built in. A company plugin adds its test
 *  environments (such as `staging`) through `config.addEnvironments`, and a tool may name a target in its own
 *  terms (such as `prod`) as long as configuration knows that name. An unknown name counts as production. */
export type EnvironmentName = string;

/** The kind of an environment decides its default rules. */
export type EnvironmentKind = "local" | "external" | "test" | "production";

/** One environment as `environments.list()` gives it. */
export interface EnvironmentInfo {
    name: EnvironmentName;
    kind: EnvironmentKind;
    /** Who defined it: Jig itself, your `jig.json`, or a company plugin. When a later definition made it production, the one
     *  that did. */
    source: "built-in" | "personal" | "company";
}

export type Effect = "read" | "write";

export type Decision = "allow" | "ask" | "deny";

/** Which screen asks the user: a one-line dialog, a scrollable review screen, or a form. */
export type ApprovalKind = "dialog" | "review" | "form";

/** What one call does, as its tool declares it. */
export interface CallClass {
    /** The action, for tools with several (`git` `push`). Omitted for single-action tools. */
    action?: string;
    environment: EnvironmentName;
    effect: Effect;
    /** A stricter default than the rules table, such as `ask` for `git restore`. Never looser. */
    atLeast?: "ask" | "deny";
    /** The screen this call uses when it asks. Default: the review screen when the preview has a body,
     *  otherwise a dialog. */
    approval?: ApprovalKind;
}

/** What the user sees when a call asks. */
export interface Preview {
    /** One line: what will happen. */
    summary: string;
    /** Long text for the review screen: a diff, a pull request body, a list of commits. */
    body?: string;
    format?: "markdown" | "diff" | "text";
    /** A page the tool rendered itself, such as Jira wiki markup turned into HTML, opened with `o` instead of the
     *  page jig-core would make from `body`. jig-core writes it with a policy that blocks scripts and network
     *  requests, so the page can only show. */
    html?: string;
    /** A digest of what was shown. The tool reads the approved preview with `approvedPreview()` and refuses to
     *  run if what it would do now has a different digest ("changed since the preview"). */
    fingerprint?: string;
    /** The words on the three buttons of a dialog, when the usual ones (`Allow`, `Allow for this session`, `Decline`)
     *  would mislead: "This exact command, this session" says what the session answer covers. */
    answers?: { allow?: string; session?: string; decline?: string };
}

/** A Jig tool's description of itself, given to jig-core once per load with `declareTool`. */
export interface ToolDeclaration {
    /** The tool's name as registered with Pi. */
    tool: string;
    /** The plugin that registered it, for records and `/jig rules`. */
    plugin: string;
    /** Classifies one call from its input. Pure and fast: it runs before every call. Returning undefined makes
     *  the call unknown, and an unknown call asks. Throwing a `TypeError` says the input is invalid: jig-core
     *  blocks the call with its message and does not ask. */
    classify(input: Readonly<Record<string, unknown>>): CallClass | undefined;
    /** Builds what the user sees before a call that asks. Read-only work only. Throwing a `TypeError` says the
     *  input is invalid: jig-core blocks the call with its message and does not ask. Any other failure shows
     *  "preview unavailable" and still asks. */
    preview?(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Preview>;
    /** True when the tool masks its own production results, so jig-core's backstop leaves them alone. */
    masksOwnResults?: boolean;
    /** For a tool Pi ships, such as `bash`, that a plugin classifies only in part: `classify` answers for the calls it
     *  knows and returns undefined for the rest, which then go on to the classification rules and the built-in defaults
     *  instead of becoming unknown. */
    extendsDefaults?: boolean;
    /** Inputs that show `/jig rules` the actions this tool picks from its input rather than from an `action` parameter,
     *  by action name: `{ outside: { outside: true, reason: "x" } }`. Used only to display the rules. */
    examples?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Facts a tool adds to its own record: a few named numbers, flags or short codes, never free text.
 *  Strings longer than 64 characters are dropped. */
export type Facts = Readonly<Record<string, number | boolean | string>>;

/** A rule from configuration, most specific first. The floor is checked when rules load: a rule that would
 *  lower it is refused with the file and key named. */
export interface Rule {
    tool: string;
    action?: string;
    environment?: EnvironmentName;
    effect?: Effect;
    /** A pattern for the `command` the call carries (a `bash` command), where `*` stands for any run of characters that
     *  holds no `;`, `&`, `|`, `<`, `>`, backquote, `$(` or line break, so an allowed command cannot carry another. A call
     *  with no `command` never matches a rule that has one. */
    command?: string;
    decision: Decision;
    approval?: ApprovalKind;
}

/** Classifies calls to a tool Jig did not write, from one of its parameters. */
export interface ClassifyRule {
    tool: string;
    action?: string;
    param: string;
    /** Matches the parameter exactly. Give `value` or `pattern`. */
    value?: string;
    /** A regular expression the parameter must match. */
    pattern?: string;
    environment: EnvironmentName;
    effect: Effect;
}

export interface EnvironmentConfig {
    kind: "test" | "production";
    /** Mask results from this test environment too. Production is always masked. */
    mask?: boolean;
}

/** The end of a watch. */
export interface WatchResult {
    outcome: "passed" | "failed" | "timed-out" | "stopped" | "error";
    /** One line for the agent and the user. */
    summary: string;
    /** A few more lines, such as the start of a failed log. jig-core masks and redacts them. */
    details?: string;
    links?: readonly string[];
    facts?: Facts;
}

/** News for the agent while a watch goes on, such as new comments on a pull request. */
export interface WatchUpdate {
    /** One line for the agent and the user. */
    summary: string;
    /** More lines, up to 40, such as the text of the news. jig-core masks and redacts them. */
    details?: string;
    links?: readonly string[];
}

/** One poll of a watch. */
export interface PollOutcome<State> {
    /** Saved with the watch, so polling resumes where it stopped after Pi restarts. */
    state: State;
    /** Set when the finish line is reached. */
    done?: WatchResult;
    /**
     * Tells the agent now, in a message of its own, and the watch goes on. Send it with the state that remembers what it
     * says, so the next poll does not say it again. A poll that is also `done` sends its update first, in the same message.
     */
    update?: WatchUpdate;
    /** The next poll sooner or later than the kind's interval, such as GitHub's `X-Poll-Interval`. */
    nextPollMs?: number;
}

/** A kind of watch a plugin can start, such as GitHub checks. Registered once per load. */
export interface WatchKind<Spec, State> {
    /** Unique across plugins, such as `ops-ci`. */
    kind: string;
    plugin: string;
    intervalMs: number;
    /** One line naming what is watched, for `watch list`. */
    describe(spec: Spec): string;
    /** Polls once. A throw is a failed poll; three in a row pause the watch with one notice. */
    poll(spec: Spec, state: State | undefined, signal: AbortSignal): Promise<PollOutcome<State>>;
}

export interface StartWatch<Spec> {
    kind: string;
    /** Plain JSON: it is saved to disk with the watch. */
    spec: Spec;
    /** One line, such as "checks of pull request 42". */
    title: string;
    /** Default 60. */
    timeoutMinutes?: number;
    /** A "still waiting" notice to the user after this long. Default 30. */
    stallMinutes?: number;
}

export interface WatchInfo {
    id: string;
    kind: string;
    plugin: string;
    title: string;
    status: "open" | "paused" | "done";
    startedAt: string;
    result?: WatchResult;
}

export interface RunOptions {
    cwd?: string;
    /** Default 60 000. */
    timeoutMs?: number;
    /** Written to the process's standard input. */
    input?: string;
    /** Added to a minimal environment; the parent's environment is not passed whole. */
    env?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    /** Output beyond this is cut. Default 10 MiB. */
    maxOutputBytes?: number;
}

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

/**
 * One request a sign-in service authenticates: everything a service that signs the request itself (an HMAC scheme, AWS
 * Signature Version 4) needs to sign it as it will be sent, so a POST is not signed as a GET.
 */
export interface SignInRequest {
    /** The system, as the tool calls it, such as `jira` or `logs`. */
    system: string;
    /** The full URL, with its query, as it will be called. */
    url: string;
    /** The method the request will use. */
    method: HttpMethod;
    /** The headers the request will carry: the caller's defaults, replaced by its own headers of the same name, and
     *  never the credential this service is about to give. The network adds its own (`Host`, `Content-Length`, and a
     *  `Content-Type` of `text/plain;charset=UTF-8` for a text body that has none), so a service that signs a
     *  `Content-Type` returns it among its headers. Names keep the case the caller wrote. */
    headers: Readonly<Record<string, string>>;
    /** The body as it will be sent: text or bytes, and absent when the request has none. Do not change it. */
    body?: string | Uint8Array;
}

/** Gives the headers that authenticate one request. It is asked for every request, and decides when a token has run
 *  out. A service that signs the request reads `method`, `url`, `headers` and `body` of the `SignInRequest`. */
export interface SignInService {
    headers(request: SignInRequest, signal?: AbortSignal): Promise<Readonly<Record<string, string>>>;
}

/** One HTTP request a transport carries. */
export interface TransportRequest {
    /** The system, as the tool calls it, such as `jira` or `logs`. */
    system: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    /** The full URL the tool would have called itself. */
    url: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
    /** The most reply bytes the caller will read: the request's `maxBytes` (4 MiB when it gave none). jig-core cuts a
     *  longer reply to this and sets `truncated`, so a transport may stop reading instead of buffering a reply that will be
     *  thrown away. Stop one byte past it, not at it: a reply of exactly this many bytes and a longer one then look different. */
    maxBytes: number;
    /** How long the whole request may take, in milliseconds: the request's `timeoutMs` (30 s when it gave none). The
     *  `signal` fires when it runs out, so a transport that honours the signal needs nothing more; this is for one that
     *  sets a limit of its own, such as a socket's. */
    timeoutMs: number;
}

export interface TransportResponse {
    status: number;
    /** A header the reply repeated, such as `set-cookie`, may be given as a list, one entry for each time it was sent.
     *  Names may be in any case; jig-core lower-cases them. */
    headers: Readonly<Record<string, string | readonly string[]>>;
    body: string;
}

/** What a tunnel's port is: `forward` reaches one host and port, `socks` reaches any host the far side can. */
export type TunnelKind = "forward" | "socks";

/** A local port that reaches a host the machine cannot reach directly, such as a database behind a bastion. */
export interface Tunnel {
    /**
     * What the port is. `forward` (the default, for a provider that does not say): the port on 127.0.0.1 reaches the one
     * host and port that was asked for, and the tool connects to it as to that host (an SSH local forward, a cloud port
     * forward). `socks`: the port on 127.0.0.1 is a SOCKS5 proxy that reaches any host the far side can, and the tool
     * connects to its real hosts through it (a SOCKS proxy on a jump host, `ssh -D`). A tool that needs several hosts, such
     * as the members of a replica set, needs `socks`.
     */
    kind?: TunnelKind;
    /** The port on 127.0.0.1 to connect to. */
    port: number;
    close(): void | Promise<void>;
}

/** A tunnel as `tunnels.open` returns it: its kind is always set. */
export interface OpenedTunnel extends Tunnel {
    kind: TunnelKind;
}

/**
 * Opens tunnels for a company, such as an SSH forward through its jump host or a cloud port forward. `target` is where
 * the tool is going. A `forward` tunnel reaches exactly that; a `socks` tunnel reaches whatever the tool asks it for, and
 * the target only tells the provider which route to open (which jump host, which region).
 */
export interface TunnelProvider {
    open(target: { host: string; port: number }, signal?: AbortSignal): Promise<Tunnel>;
}

/** Carries requests to a company's systems itself, such as through a local sign-in proxy that holds the session, so
 *  the tool never sees a credential. */
export interface Transport {
    request(request: TransportRequest, signal?: AbortSignal): Promise<TransportResponse>;
}

/** The methods a request may use. A transport carries only GET, POST, PUT, PATCH and DELETE. */
export type HttpMethod = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A value of a token request: plain text such as a client id, or a secret reference read just before the request. */
export type HttpValue = string | { ref: string };

/**
 * A token from a token endpoint, with no browser: the client-credentials grant (RFC 6749, section 4.4) or the
 * password grant (section 4.3). jig-core reads the secrets, asks for the token, keeps it in memory until shortly
 * before it expires, and sends it as a bearer token. The token is never written anywhere.
 */
export interface HttpOAuth {
    grant: "client_credentials" | "password";
    tokenUrl: string;
    clientId: HttpValue;
    /** A client with a secret signs in with HTTP Basic unless `clientAuth` is `body`. */
    clientSecret?: HttpValue;
    /** For the password grant. */
    username?: HttpValue;
    password?: HttpValue;
    scope?: string;
    /** Where the client's id and secret go: HTTP Basic (RFC 6749 asks for it first), or the form. Default `header`. */
    clientAuth?: "header" | "body";
    /** A label that keeps tokens apart, such as `api:orders/staging`. A token is reused only for the same label and
     *  the same settings. */
    cache?: string;
}

/**
 * Where the credential of a request comes from. Exactly one. A `ref` is a secret reference (`env:LOGS_TOKEN`,
 * `cmd:gh`, `pass:work/token`) that jig-core resolves just before the request, so plugin code never sees the value.
 */
export type HttpAuth =
    | { bearer: string }
    | { basic: { user: string; password: string } }
    | { header: { name: string; value: string; prefix?: string } }
    | { query: { name: string; value: string } }
    | { signIn: string }
    | { oauth: HttpOAuth };

/** One HTTP request for `http.request`. */
export interface HttpRequest {
    /** The system, as sign-in services and transports are told it, such as `jira` or `logs`. */
    system: string;
    url: string;
    method: HttpMethod;
    headers?: Readonly<Record<string, string>>;
    /** Headers the caller would send by default (an `Accept`, a `User-Agent`): a header in `headers` replaces one of the
     *  same name, and so does the credential's, whatever `onHeaderClash` says. */
    defaultHeaders?: Readonly<Record<string, string>>;
    /** Text, or bytes. A transport carries text only. */
    body?: string | Uint8Array;
    /** The credential, from a source the user configured. Not with `transport`: a transport signs in itself. */
    auth?: HttpAuth;
    /** The name of a registered transport that carries the request instead of the network. */
    transport?: string;
    /** What happens when a header in `headers` has the same name (ignoring case) as one the credential sets: the
     *  credential's `replace`s it (the default), or the request is `refuse`d with `invalid_request`, so one of the two
     *  never silently wins. */
    onHeaderClash?: "replace" | "refuse";
    /** From 1 ms to 10 minutes. Default 30 s. (A `signal` that fires with a `TimeoutError`, such as
     *  `AbortSignal.timeout`, also ends the request as a `timeout`.) It starts after the credential is in hand: a secret store may wait for
     *  you to unlock it. */
    timeoutMs?: number;
    /** The most reply bytes that are read; more is cut and `truncated` is set. From 1 byte to 64 MiB. Default 4 MiB. */
    maxBytes?: number;
}

export interface HttpResponse {
    status: number;
    /** Lower-case names. A redirect is never followed: its address is `headers.location`. */
    headers: Readonly<Record<string, string>>;
    /** What the reply set, as `name=value`. There is no cookie jar. */
    cookies: readonly string[];
    /** The body as text, cut at `maxBytes`. Credentials that were sent are replaced by `[redacted]`. */
    body: string;
    /** How many bytes of the reply were read. */
    bytes: number;
    /** True when the reply was longer than `maxBytes` and was cut. */
    truncated: boolean;
    /** True when the first 4 KiB of the reply hold a NUL byte, so it is probably not text. */
    binary: boolean;
}

/**
 * Why a request got no reply. `code` is one of: `invalid_request`, `auth_failed`, `no_transport`, `transport_failed`,
 * `timeout`, `aborted`, a system or TLS code such as `ECONNREFUSED` or `CERT_HAS_EXPIRED`, or `network_error` when the
 * failure had no code. The message never holds a header value, a credential or the query of the address.
 */
export interface HttpErrorInfo extends Error {
    readonly name: "HttpError";
    readonly code: string;
    /** True when the request cannot have reached the server (a bad request, a credential that could not be read, no
     *  connection, a certificate that was refused, a call cancelled first). False when it may have, so a write may have
     *  happened. */
    readonly notSent: boolean;
}

/** One path that Pi's file tools must not touch, as `protectedPaths.list()` gives it. */
export interface ProtectedPathInfo {
    /** Absolute, as it is matched. */
    path: string;
    /** For messages: the path with the home folder written as `~`. */
    shown: string;
    /** `secret` is neither read nor written; `guarded` can be read but not written. */
    kind: "secret" | "guarded";
    /** Where the entry came from: the built-in list, your `jig.json`, or a company plugin. */
    source: "default" | "personal" | "company";
}

/** The network a sandboxed `bash` has. */
export type SandboxNetworkMode = "open" | "filtered" | "ask" | "off";

/** What a plugin asks for when it runs a command in the sandbox with `sandbox.run`. */
export interface SandboxRunOptions {
    /** The folder the command runs in: absolute. */
    cwd: string;
    /** From 1 ms to 2 hours. Without it the command may run until `signal` fires. */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** The most output kept: the end of it, when there is more. Default 256 KiB. */
    maxOutputBytes?: number;
}

/** How a command run in the sandbox ended. */
export interface SandboxRunResult {
    /** The exit code, or null when the command was stopped (a timeout) or could not report one. */
    code: number | null;
    /** What the command printed, both streams together, cleaned of terminal control codes and with credentials taken out. */
    output: string;
    timedOut: boolean;
    /** True when `output` is only the end of what the command printed. */
    truncated: boolean;
}

/** What a sandbox plugin tells jig-core about the `bash` it runs. Fields are read when they are needed, so they may change. */
export interface SandboxProvider {
    /** True while `bash` commands run inside the sandbox. False when it is switched off, or could not start. */
    readonly active: boolean;
    /** The network mode, while active. */
    readonly mode?: SandboxNetworkMode;
    /** One line for `/jig` that says why the sandbox is not active, or anything else the user should know. */
    readonly note?: string;
    /** Whether a command in the sandbox can write this path: absolute, links followed. A program there is not one Jig may run. */
    canWrite(path: string): boolean;
    /** Settles when the sandbox has started, or failed to, so that session start can say which. */
    whenReady?(): Promise<void>;
    /** Runs a shell command the way the sandbox runs the agent's `bash`: the same rules, environment and audit, without
     *  the tool around it. Rejects when the sandbox refuses the command or the command is cancelled; a command that
     *  ran and failed, or timed out, is a result. Optional: a sandbox without it still hides `bash`, and `sandbox.canRun`
     *  is false. */
    run?(command: string, options: SandboxRunOptions): Promise<SandboxRunResult>;
}

/**
 * A call as a gate sees it, after the rules have decided. Frozen: a gate looks and does not change what runs.
 */
export interface GateCall {
    toolCallId: string;
    tool: string;
    action?: string;
    environment: EnvironmentName;
    environmentKind: EnvironmentKind;
    effect: Effect;
    /** What has been decided so far. A call that is already denied is not shown to gates. */
    decision: "allow" | "ask";
    /** The call's input, as the model sent it. */
    input: Readonly<Record<string, unknown>>;
    /** Pi's working folder: where a relative path starts. */
    cwd: string;
    /** For Pi's `write` and `edit`: the absolute path the call acts on, as written once `~` and `..` are resolved, and
     *  with every link followed (the same path twice when there is no link). Empty for every other tool. */
    paths: readonly string[];
}

/** What a gate may answer: stricter, never looser. */
export interface GateVerdict {
    decision: "ask" | "deny";
    /** One line for the model and the user: why. It names the condition and what fixes it. */
    reason: string;
}

/**
 * A check a plugin registers with `gates.register`. jig-core asks every gate about each call once the rules have decided,
 * and a gate can only make the decision stricter: an `allow` becomes an `ask` or a `deny`, an `ask` becomes a `deny`.
 */
export interface Gate {
    /** Unique: registering the same name again replaces the gate. */
    name: string;
    /** The plugin that registered it, for `/jig`. */
    plugin: string;
    /** Answers nothing to leave the decision as it is. Throwing, or taking more than 10 seconds, denies the call. */
    check(call: GateCall, signal: AbortSignal): GateVerdict | undefined | Promise<GateVerdict | undefined>;
}

/** jig-core's run-time API, reached through `jig()` in client.ts. */
export interface JigApi {
    readonly version: 1;

    /** Declares how a tool's calls are classified. Declaring the same tool again replaces it. */
    declareTool(declaration: ToolDeclaration): void;

    /** The preview the user approved for this call, or undefined when the call did not ask. */
    approvedPreview(toolCallId: string): Preview | undefined;

    /** Adds facts to this call's record. */
    addFacts(toolCallId: string, facts: Facts): void;

    /** The ticket the session works on, set by jig-workflow. Records carry it. */
    setTicket(key: string | undefined): void;

    readonly secrets: {
        /** Resolves a reference such as `pass:github/token` through an allowed backend. The value is
         *  redacted from every tool result until Pi exits. */
        resolve(ref: string, signal?: AbortSignal): Promise<string>;
    };

    /** What jig-core knows about environments, so a tool can refuse an action by kind, such as never in production,
     *  whatever a company names its environments. */
    readonly environments: {
        /** The kind of an environment name: built in, configured or added by a company plugin. A name nobody defined
         *  counts as production. */
        kindOf(name: EnvironmentName): EnvironmentKind;
        /** Every environment that is defined, with its kind and who defined it: the built-in ones first, then a company
         *  plugin's, then yours. A name nobody defined is not in it (it counts as production). */
        list(): readonly EnvironmentInfo[];
    };

    /** Tunnel providers a company plugin registers, for tools that need a network route of their own, such as a
     *  database connection. */
    readonly tunnels: {
        /** Registering the same name again replaces the provider. */
        register(name: string, provider: TunnelProvider): void;
        /** Opens a tunnel through a registered provider. Throws when no provider has this name, or when the tunnel it
         *  gives is not valid. A tunnel whose provider did not say its kind is a `forward`. */
        open(name: string, target: { host: string; port: number }, signal?: AbortSignal): Promise<OpenedTunnel>;
    };

    /** Transports a company plugin provides for its systems. A tool configured with a transport's name sends its HTTP
     *  requests through it instead of calling the network itself. */
    readonly transports: {
        /** Registering the same name again replaces the transport. */
        register(name: string, transport: Transport): void;
        /** Sends one request through a registered transport. Throws when no transport has this name. */
        request(name: string, request: TransportRequest, signal?: AbortSignal): Promise<TransportResponse>;
    };

    /** Sign-in services a company plugin provides for its systems, such as a single sign-on gateway. Tools such
     *  as jig-jira and jig-logs use one when their configuration names it instead of a secret reference. */
    readonly signIn: {
        /** Registering the same name again replaces the service. */
        register(name: string, service: SignInService): void;
        /** The headers that authenticate one request. Their values are redacted from every tool result, like
         *  secrets. Throws when no service has this name. */
        headers(name: string, request: SignInRequest, signal?: AbortSignal): Promise<Readonly<Record<string, string>>>;
    };

    /**
     * Sends one HTTP request with a credential that jig-core reads for it, so plugin code never sees the value. It never
     * follows a redirect (a 3xx comes back with its `location`), caps the reply, and throws an `HttpError` with a `code`
     * for a request that got no reply. Requests that share one `signal` read a secret once, so the several requests of
     * one call may pass the same signal (`AbortSignal.any([])` makes one when the call has none). See
     * `docs/plugin-contract.md` and `docs/sign-in-and-transports.md`.
     */
    readonly http: {
        request(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
    };

    /** Replaces customer personal data with tokens that stay the same all day. Throws if it cannot mask;
     *  the caller then drops the result. */
    readonly mask: {
        text(input: string): string;
        value<T>(input: T): T;
    };

    readonly watches: {
        registerKind<Spec, State>(kind: WatchKind<Spec, State>): void;
        /** Starts a watch and returns its id at once. */
        start<Spec>(watch: StartWatch<Spec>): string;
        list(): WatchInfo[];
        /** False when no open watch has this id. */
        stop(id: string): boolean;
    };

    /** What company plugins add at start-up. Personal configuration wins over it, and the floor holds. */
    readonly config: {
        addEnvironments(environments: Readonly<Record<EnvironmentName, EnvironmentConfig>>): void;
        addRules(rules: readonly Rule[]): void;
        addClassifyRules(rules: readonly ClassifyRule[]): void;
        /** Paths Pi's own file tools must not touch, on top of the built-in ones: `secret` paths are neither read nor
         *  written, `guarded` paths can be read but not written. Each path is absolute or starts with `~/`. This can only
         *  add: the built-in paths and the user's own cannot be removed. */
        addProtectedPaths(paths: { secret?: readonly string[]; guarded?: readonly string[] }): void;
        /** Commands that a secret reference `cmd:<name>` may run, by name: `{ gh: ["gh", "auth", "token"] }`. The first
         *  word is the program, the rest its arguments; no shell is used. A name the user also declares in `jig.json`
         *  (`secrets.commands`) takes the user's command. They run only when `cmd` is in `secrets.backends`. */
        addSecretCommands(commands: Readonly<Record<string, readonly string[]>>): void;
        /** Turns secret backends on (`pass`, `env`, `keychain`, `op`, `cmd`, `file`) for the references a company's sign-in and
         *  settings name, so each user need not add them. A company plugin is code that already runs in Pi with the user's
         *  rights, so this gives it nothing new; the user keeps the last word, because `secrets.disabledBackends` in `jig.json`
         *  turns any backend off whoever turned it on. Without a company plugin the default stays `pass` alone, and `/jig`
         *  lists the backends that are on and who enabled them. A name that is not a backend is a configuration problem
         *  named `company`. */
        enableSecretBackends(backends: readonly string[]): void;
        /** Field names that hold personal data in a company's own systems. The masker treats them like its
         *  built-in personal fields and turns their values into `personal#` tokens. */
        addMaskFields(fields: readonly string[]): void;
        /** A plugin's own section of jig.json, such as `git` or `lens`. jig-core reports a top-level key that
         *  neither jig-core nor a plugin registered as an unknown field. `validate` returns error messages that
         *  name the key; with errors, `section()` returns undefined and the plugin uses its defaults.
         *
         *  When a company plugin gave defaults for the section (`addSectionDefaults`), `validate` is given the user's
         *  section laid over them, so the user writes only what they change, and a field that only the user can give
         *  may be missing from the defaults.
         *
         *  `replace` names keys whose object in the user's section replaces the company's whole instead of merging
         *  into it. Use it where an object is one choice among several, such as an `auth` of `{ transport }` or of
         *  `{ token }`: merged, the two would make a mix that is neither. A key is a path from the section's root,
         *  with `*` for any one name: `auth`, `backend.auth`, `services.*.ci.auth`.
         *
         *  `oneOf` lists keys in one object that exclude each other, such as `["backend.auth", "backend.transport"]`:
         *  when the user's section sets one of them, the company's value for the others is dropped. */
        registerSection(
            name: string,
            validate: (raw: unknown) => readonly string[],
            options?: { replace?: readonly string[]; oneOf?: readonly (readonly string[])[] },
        ): void;
        /** A company plugin's defaults for a plugin's section, such as its log backend or its service catalog. Your own
         *  section in jig.json is laid over them: objects merge key by key, any other value of yours replaces theirs,
         *  and a key the plugin named in `registerSection`'s `replace` is replaced whole. The result is checked by the
         *  plugin's own validation. With no section of your own, the defaults alone are checked: when they are not
         *  valid (a field only the user can give is missing), the plugin is not configured, no problem is reported,
         *  and `/jig` says the company defaults are incomplete. */
        addSectionDefaults(name: string, defaults: unknown): void;
        /** The section as loaded at the last session start, after validation: the user's, laid over the company's
         *  defaults when it gave some. Undefined when absent or invalid. */
        section(name: string): unknown;
    };

    /** The paths Pi's file tools must not touch, so that a sandbox for `bash` can hide the same ones. */
    readonly protectedPaths: {
        /** Every entry, with its kind and where it came from: the built-in ones, your `jig.json` and company plugins. */
        list(): readonly ProtectedPathInfo[];
    };

    /** The sandbox around `bash`, when a plugin provides one. */
    readonly sandbox: {
        /** Says that `bash` runs in this sandbox. `/jig` and session start report it, and `exec.run` refuses a program in a
         *  place the sandbox can write. Registering again replaces the provider. */
        register(provider: SandboxProvider): void;
        /** True when a command can be run in the sandbox now: a provider is registered, it is active, and it can `run`. */
        readonly canRun: boolean;
        /** Runs a shell command in the sandbox, as `bash` would. Rejects when `canRun` is false, so a plugin never runs a
         *  command outside the sandbox by asking for the sandbox. */
        run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult>;
    };

    /** Checks other plugins add to every call. See `Gate`. */
    readonly gates: {
        /** A gate that is not a function or has no name is a `TypeError`. Registering the same name again replaces it. */
        register(gate: Gate): void;
    };

    /** The queue jig-core's questions wait in. Pi has one dialog slot, so questions are asked one at a time. */
    readonly approvals: {
        /** Runs `job` when no question is open and holds the queue until it ends, so a plugin that asks the user
         *  something of its own (a sandbox asking about a host) never opens a question over one of jig-core's. A job
         *  that fails does not stop the ones behind it. */
        inTurn<T>(job: () => Promise<T>): Promise<T>;
    };

    /**
     * Lines for `/jig` that a plugin wants the user to see about its own state, such as a safety check that the user turned
     * off. Always present in `jig-core`; optional here only so that a test's stand-in for `jig-core` need not have it.
     */
    readonly status?: {
        /** `lines` is asked each time `/jig` runs, and returns nothing when there is nothing to say. Each line is cut to one
         *  line of 300 characters. Registering the same `plugin` again replaces its lines. */
        register(plugin: string, lines: () => readonly string[]): void;
    };

    /** Runs programs from an argument list, never a shell. */
    readonly exec: {
        /** Refuses a program whose real path is in a folder the agent's shell can write: the working folder, and with a
         *  sandbox registered, every place the sandbox lets `bash` write. A program planted there would run with your
         *  credentials. `git`, `gh` and `glab` are also refused in a repository whose own `.git/config` would run a command,
         *  because all three start git. */
        run(file: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
        /** git with hooks, `core.fsmonitor` and prompts off. Refuses to run when the repository's `.git/config`
         *  holds a setting that would run a command, because the agent's shell can write that file. */
        git(repo: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
    };
}

/** Events jig-core publishes on Pi's event bus (`pi.events`). */
export const JIG_EVENTS = {
    /** After every decision on a call. Payload: `DecisionEvent`. */
    decision: "jig:decision",
    /** When a watch ends. Payload: `WatchDoneEvent`. */
    watchDone: "jig:watch-done",
} as const;

export interface DecisionEvent {
    toolCallId: string;
    tool: string;
    action?: string;
    environment: EnvironmentName;
    environmentKind: EnvironmentKind;
    effect: Effect;
    decision: Decision;
    /** Where the decision came from. */
    source: "floor" | "rule" | "session" | "tool" | "table" | "unknown" | "gate";
    /** Set when a gate asked or denied this call: the gate's name. */
    gate?: string;
    /** Set when the call asked. */
    answer?: "allow" | "allow-session" | "decline";
}

export interface WatchDoneEvent {
    id: string;
    kind: string;
    plugin: string;
    title: string;
    result: WatchResult;
}
