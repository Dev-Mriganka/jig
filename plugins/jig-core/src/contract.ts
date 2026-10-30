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
}

/** A Jig tool's description of itself, given to jig-core once per load with `declareTool`. */
export interface ToolDeclaration {
    /** The tool's name as registered with Pi. */
    tool: string;
    /** The plugin that registered it, for records and `/jig rules`. */
    plugin: string;
    /** Classifies one call from its input. Pure and fast: it runs before every call. Returning undefined makes
     *  the call unknown, and an unknown call asks. */
    classify(input: Readonly<Record<string, unknown>>): CallClass | undefined;
    /** Builds what the user sees before a call that asks. Read-only work only. Throwing a `TypeError` says the
     *  input is invalid: jig-core blocks the call with its message and does not ask. Any other failure shows
     *  "preview unavailable" and still asks. */
    preview?(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Preview>;
    /** True when the tool masks its own production results, so jig-core's backstop leaves them alone. */
    masksOwnResults?: boolean;
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

/** One poll of a watch. */
export interface PollOutcome<State> {
    /** Saved with the watch, so polling resumes where it stopped after Pi restarts. */
    state: State;
    /** Set when the finish line is reached. */
    done?: WatchResult;
    /** The next poll sooner or later than the kind's interval, such as GitHub's `X-Poll-Interval`. */
    nextPollMs?: number;
}

/** A kind of watch a plugin can start, such as GitHub checks. Registered once per load. */
export interface WatchKind<Spec, State> {
    /** Unique across plugins, such as `github-checks`. */
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

/** One request a sign-in service authenticates. */
export interface SignInRequest {
    /** The system, as the tool calls it, such as `jira` or `logs`. */
    system: string;
    url: string;
}

export interface SignInService {
    headers(request: SignInRequest, signal?: AbortSignal): Promise<Readonly<Record<string, string>>>;
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

    /** The ticket the session works on, set by jig-flow. Records carry it. */
    setTicket(key: string | undefined): void;

    readonly secrets: {
        /** Resolves a reference such as `pass:github/token` through an allowed backend. The value is
         *  redacted from every tool result until Pi exits. */
        resolve(ref: string, signal?: AbortSignal): Promise<string>;
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
        /** Field names that hold personal data in a company's own systems. The masker treats them like its
         *  built-in personal fields and turns their values into `personal#` tokens. */
        addMaskFields(fields: readonly string[]): void;
        /** A plugin's own section of jig.json, such as `git` or `lens`. jig-core reports a top-level key that
         *  neither jig-core nor a plugin registered as an unknown field. `validate` returns error messages that
         *  name the key; with errors, `section()` returns undefined and the plugin uses its defaults. */
        registerSection(name: string, validate: (raw: unknown) => readonly string[]): void;
        /** The section as loaded at the last session start, after validation. Undefined when absent or invalid. */
        section(name: string): unknown;
    };

    /** Runs programs from an argument list, never a shell. */
    readonly exec: {
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
    source: "floor" | "rule" | "session" | "tool" | "table" | "unknown";
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
