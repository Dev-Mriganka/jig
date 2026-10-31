// What jig-core keeps while Pi runs: the declared tools, the configuration, the questions' memory, and one small record
// for every call in flight. The hooks in `gate.ts` and `results.ts` and the API in `api.ts` all work on this object.
//
// A new object is made every time Pi loads the extension (start-up, reload, a new session), so nothing here outlives
// its runtime.
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createApprovals } from "./approvals.ts";
import type { Approvals } from "./approvals.ts";
import type { Classification } from "./classify.ts";
import { buildPolicy, defaultConfig, effectiveBackends, emptyAdditions, loadConfigFile } from "./config.ts";
import type { CompanyAdditions, LoadedConfig, Policy, SectionCheck } from "./config.ts";
import { JIG_EVENTS } from "./contract.ts";
import type { ApprovalKind, Decision, EnvironmentKind, Preview, SandboxProvider, ToolDeclaration } from "./contract.ts";
import type { DecisionSource } from "./decide.ts";
import { errorMessage } from "./errors.ts";
import { createGates } from "./gates.ts";
import type { Gates } from "./gates.ts";
import { createMasker, dailyMaskKey } from "./mask/index.ts";
import type { Masker } from "./mask/index.ts";
import { stateDir } from "./paths.ts";
import { defaultProtectedPaths } from "./protected-paths.ts";
import { openInBrowser, writePreviewPage } from "./preview-html.ts";
import { createRedactor } from "./redact.ts";
import type { Redactor } from "./redact.ts";
import type { Answer, ErrorKind } from "./records.ts";
import { createHttp } from "./kit/http.ts";
import type { JigApi } from "./contract.ts";
import { createSecrets } from "./secrets.ts";
import type { Secrets } from "./secrets.ts";
import { createSignIn } from "./signin.ts";
import type { SignIn } from "./signin.ts";
import { createTransports } from "./transports.ts";
import { createTunnels } from "./tunnels.ts";
import type { Tunnels } from "./tunnels.ts";
import type { Transports } from "./transports.ts";
import { createWatchEngine } from "./watch/engine.ts";
import type { WatchEngine } from "./watch/engine.ts";
import { createWatchStore } from "./watch/store.ts";
import type { Timers } from "./watch/timers.ts";

/** What a test (or an embedding program) can replace. A real Pi session uses the defaults. */
export interface JigCoreOptions {
    /** Makes the masker for a day, with the field names company plugins added. The default masks with the key of
     *  that day. */
    createMasker?: (stateDir: string, now: Date, extraFields: readonly string[]) => Masker;
    /** Shows the rendered preview in the browser. The default writes the page under the state folder and opens it. */
    openPreview?: (preview: Preview, header: string) => Promise<string>;
    now?: () => Date;
    /** The timers the watch engine uses. The default is Node's, none of which keeps the process alive. */
    timers?: Timers;
    /** How long one gate may take before the call it checks is denied. Default 10 seconds. */
    gateTimeoutMs?: number;
}

/** What jig-core remembers about one call, from the moment it is decided until its record is written. */
export interface CallState {
    toolCallId: string;
    parentToolCallId?: string;
    tool: string;
    classification: Classification;
    environmentKind: EnvironmentKind;
    /** Whether this call's results go through the mask backstop. */
    masked: boolean;
    /** The tool says it masks its own results, so the backstop leaves them alone. */
    masksOwnResults: boolean;
    decision: Decision;
    decisionSource: DecisionSource;
    /** Set when the call asked. */
    approval?: { kind: ApprovalKind; answer: Answer; waitedMs: number };
    approvedPreview?: Preview;
    /** The gate that asked or denied this call, when one did. */
    gate?: string;
    /** The plugin that registered the tool, for records. */
    plugin?: string;
    /** Set when jig-core stopped the call. `line` is for the record and holds no text the user typed. */
    blocked?: { kind: ErrorKind; line: string };
    /** Set when the tool ran but its result was withheld from the model. */
    withheld?: string;
    facts: Record<string, unknown>;
    /** Where the full text went, when the result was cut. */
    spill?: string;
}

export interface JigState {
    pi: ExtensionAPI;
    now: () => Date;
    declarations: Map<string, ToolDeclaration>;
    personal: LoadedConfig;
    company: CompanyAdditions;
    /** The sections of jig.json that plugins registered, with their checks. Registered when plugins load, before
     *  the file is read at session start. */
    sectionChecks: Map<string, SectionCheck>;
    /** Company defaults per plugin section, laid under the personal section. */
    sectionDefaults: Map<string, unknown>;
    /** The paths that replace the company's defaults instead of merging into them, per plugin section. */
    sectionReplace: Map<string, readonly string[]>;
    /** The paths that exclude each other, per plugin section: yours displaces the company's rivals. */
    sectionOneOf: Map<string, readonly (readonly string[])[]>;
    /** The paths of lists that add up (the company's entries, then yours) instead of being replaced, per plugin section. */
    sectionUnion: Map<string, readonly string[]>;
    /** Where jig.json is. The extension sets it, because only it knows Pi's agent folder. Empty until then. */
    configPath: () => string;
    /** Pi's agent folder, which holds jig.json and is protected from Pi's file tools. The extension sets it. Empty until
     *  then, and the paths inside it are left out of the protected ones. */
    agentDir: () => string;
    /** True once jig.json has been read in this runtime. */
    configLoaded: boolean;
    sessionId: string | undefined;
    /** The screen of the running session, or undefined when it has none (print mode). Set when the session starts. */
    screen: Pick<ExtensionUIContext, "notify"> | undefined;
    ticket: string | undefined;
    /** Keys from `sessionKey`, added when the user answers "Allow for this session". */
    sessionAllows: Set<string>;
    /** Calls between their decision and the end of their execution, by tool call id. */
    calls: Map<string, CallState>;
    redactor: Redactor;
    secrets: Secrets;
    /** `jig().http`, bound to this runtime's secrets, sign-in services and transports. */
    http: JigApi["http"];
    signIn: SignIn;
    transports: Transports;
    tunnels: Tunnels;
    approvals: Approvals;
    /** The checks other plugins registered, asked about each call after the rules. */
    gates: Gates;
    watches: WatchEngine;
    /** Field names that company plugins added to the masker, in the order they came. */
    maskFields: string[];
    /** The masker for today. Throws if masking cannot be done. */
    masker(): Masker;
    /** Adds field names that hold personal data. A name the masker would refuse is left out and reported as a
     *  start-up problem. The next call to `masker()` builds a new masker that knows the new names. */
    addMaskFields(fields: readonly string[]): void;
    /** The merged configuration. Rebuilt when something changes it. */
    policy(): Policy;
    invalidatePolicy(): void;
    /** The sandbox that runs `bash`, once a plugin registers one. */
    sandbox: SandboxProvider | undefined;
    /** The lines plugins want `/jig` to show, by plugin name (`status.register`). */
    statusLines: Map<string, () => readonly string[]>;
    /** The last time writing a record failed, for `/jig`. */
    recordsProblem: string | undefined;
    /** Problems from loading that are not configuration, such as a plugin whose start-up callback threw. */
    startupProblems: string[];
}

/** A key for checking field names only. Nothing is ever masked with it. */
const NAME_CHECK_KEY = new Uint8Array(32);

/** A field name from another package, as it is shown in a message: quoted, one line, short. */
function shownName(name: unknown): string {
    if (typeof name !== "string") return `a ${typeof name}`;
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, "?");
    return JSON.stringify(clean.length > 40 ? `${clean.slice(0, 40)}...` : clean);
}

/** Why the masker refused, without its "masking failed: " lead. */
function reasonOf(error: unknown): string {
    return errorMessage(error).replace(/^masking failed: /, "");
}

/** Most calls remembered at once. A call whose end event never comes would otherwise stay for ever. */
export const MAX_OPEN_CALLS = 1000;

export function createState(pi: ExtensionAPI, options: JigCoreOptions = {}): JigState {
    const now = options.now ?? (() => new Date());
    const redactor = createRedactor();
    const makeMasker =
        options.createMasker ?? ((dir, date, extraFields) => createMasker(dailyMaskKey(dir, date), { extraFields }));

    // The mask tokens stay the same all day, so the masker is made once per UTC day.
    let maskerDay: string | undefined;
    let maskerToday: Masker | undefined;

    let policy: Policy | undefined;

    const state: JigState = {
        pi,
        now,
        declarations: new Map(),
        personal: {
            file: "",
            found: false,
            config: defaultConfig(),
            problems: [],
            sections: new Map(),
            incomplete: new Map(),
            invalid: new Set(),
        },
        company: emptyAdditions(),
        sectionChecks: new Map(),
        sectionDefaults: new Map(),
        sectionReplace: new Map(),
        sectionOneOf: new Map(),
        sectionUnion: new Map(),
        configPath: () => "",
        agentDir: () => "",
        configLoaded: false,
        sessionId: undefined,
        screen: undefined,
        ticket: undefined,
        sessionAllows: new Set(),
        calls: new Map(),
        redactor,
        secrets: createSecrets({
            backends: () => effectiveBackends(state.personal.config.secrets, state.company).on,
            disabled: () => state.personal.config.secrets.disabledBackends,
            // The user's own commands replace a company's of the same name.
            commands: () => ({ ...state.company.secretCommands, ...state.personal.config.secrets.commands }),
            agentDir: () => state.agentDir(),
            redactor,
        }),
        http: undefined as unknown as JigApi["http"],
        signIn: createSignIn({ redactor }),
        transports: createTransports(),
        tunnels: createTunnels(),
        approvals: createApprovals({
            now: () => Date.now(),
            openPreview:
                options.openPreview ?? (async (preview, header) => openInBrowser(writePreviewPage(preview, header))),
        }),
        gates: createGates(options.gateTimeoutMs === undefined ? {} : { timeoutMs: options.gateTimeoutMs }),
        watches: createWatchEngine({
            now: () => now().getTime(),
            ...(options.timers === undefined ? {} : { timers: options.timers }),
            store: createWatchStore(),
            // A message to the agent does not pass the hook that cleans tool results: the engine cleans its own text.
            protect: { redact: (text) => redactor.text(text), mask: (text) => state.masker().text(text) },
            notify(message, level) {
                if (state.screen === undefined) return false;
                try {
                    state.screen.notify(message, level);
                    return true;
                } catch {
                    // A screen from an earlier runtime can be gone; the watch goes on without it.
                    return false;
                }
            },
            emit: (event) => pi.events.emit(JIG_EVENTS.watchDone, event),
            send: (message) => pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true }),
        }),
        maskFields: [],
        masker() {
            const date = now();
            const day = date.toISOString().slice(0, 10);
            if (maskerToday === undefined || maskerDay !== day) {
                maskerToday = makeMasker(stateDir(), date, [...state.maskFields]);
                maskerDay = day;
            }
            return maskerToday;
        },
        addMaskFields(fields) {
            // A bare string would be read letter by letter, and silently protect the wrong fields.
            if (!Array.isArray(fields)) throw new TypeError("addMaskFields: give a list of field names");
            for (const field of fields) {
                // The masker is the judge of a name. One it refuses could never match a field, so leaving it out
                // loses no protection; the rest of the list still applies.
                try {
                    createMasker(NAME_CHECK_KEY, { extraFields: [field] });
                } catch (error) {
                    state.startupProblems.push(`addMaskFields ignored ${shownName(field)}: ${reasonOf(error)}`);
                    continue;
                }
                if (!state.maskFields.includes(field)) state.maskFields.push(field);
            }
            // Built again when next needed. Tokens do not change: they come from the key of the day, not the fields.
            maskerToday = undefined;
        },
        policy() {
            if (policy === undefined) {
                const home = homedir();
                const entries = defaultProtectedPaths({ agentDir: state.agentDir(), home, env: process.env });
                policy = buildPolicy(state.personal, state.company, { entries, home });
            }
            return policy;
        },
        invalidatePolicy() {
            policy = undefined;
        },
        sandbox: undefined,
        statusLines: new Map(),
        recordsProblem: undefined,
        startupProblems: [],
    };
    state.http = createHttp({
        secrets: state.secrets,
        signIn: state.signIn,
        transports: state.transports,
        redact: (value) => redactor.register(value),
    });
    return state;
}

/** Remembers a call. The oldest one is forgotten when too many are open. */
export function rememberCall(state: JigState, call: CallState): void {
    state.calls.set(call.toolCallId, call);
    if (state.calls.size > MAX_OPEN_CALLS) {
        const oldest = state.calls.keys().next().value;
        if (oldest !== undefined) state.calls.delete(oldest);
    }
}

/** Reads jig.json, with the sections plugins registered, and rebuilds the policy. Run at session start. */
export function loadPersonalConfig(state: JigState, file: string = state.configPath()): void {
    state.personal = loadConfigFile(file, state.sectionChecks, {
        defaults: state.sectionDefaults,
        replace: state.sectionReplace,
        oneOf: state.sectionOneOf,
        union: state.sectionUnion,
    });
    state.configLoaded = true;
    state.invalidatePolicy();
}

/** Reads jig.json now if nothing has yet. A plugin that is loaded before jig-core runs its `session_start` handler
 *  before jig-core's, and asking for its section there must not depend on that order. */
export function ensureConfigLoaded(state: JigState): void {
    if (!state.configLoaded && state.configPath() !== "") loadPersonalConfig(state);
}
