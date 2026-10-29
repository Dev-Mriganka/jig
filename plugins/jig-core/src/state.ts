// What jig-core keeps while Pi runs: the declared tools, the configuration, the questions' memory, and one small record
// for every call in flight. The hooks in `gate.ts` and `results.ts` and the API in `api.ts` all work on this object.
//
// A new object is made every time Pi loads the extension (start-up, reload, a new session), so nothing here outlives
// its runtime.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApprovals } from "./approvals.ts";
import type { Approvals } from "./approvals.ts";
import type { Classification } from "./classify.ts";
import { buildPolicy, defaultConfig, emptyAdditions, loadConfigFile } from "./config.ts";
import type { CompanyAdditions, LoadedConfig, Policy, SectionCheck } from "./config.ts";
import type { ApprovalKind, Decision, EnvironmentKind, JigApi, Preview, ToolDeclaration } from "./contract.ts";
import type { DecisionSource } from "./decide.ts";
import { createMasker, dailyMaskKey } from "./mask/index.ts";
import type { Masker } from "./mask/index.ts";
import { stateDir } from "./paths.ts";
import { openInBrowser, writePreviewPage } from "./preview-html.ts";
import { createRedactor } from "./redact.ts";
import type { Redactor } from "./redact.ts";
import type { Answer, ErrorKind } from "./records.ts";
import { createSecrets } from "./secrets.ts";
import type { Secrets } from "./secrets.ts";
import { createWatchPlaceholder } from "./watch-placeholder.ts";

/** What a test (or an embedding program) can replace. A real Pi session uses the defaults. */
export interface JigCoreOptions {
    /** Makes the masker for a day. The default masks with the key of that day. */
    createMasker?: (stateDir: string, now: Date) => Masker;
    /** Shows the rendered preview in the browser. The default writes the page under the state folder and opens it. */
    openPreview?: (preview: Preview, header: string) => Promise<string>;
    now?: () => Date;
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
    /** Where jig.json is. The extension sets it, because only it knows Pi's agent folder. Empty until then. */
    configPath: () => string;
    /** True once jig.json has been read in this runtime. */
    configLoaded: boolean;
    sessionId: string | undefined;
    ticket: string | undefined;
    /** Keys from `sessionKey`, added when the user answers "Allow for this session". */
    sessionAllows: Set<string>;
    /** Calls between their decision and the end of their execution, by tool call id. */
    calls: Map<string, CallState>;
    redactor: Redactor;
    secrets: Secrets;
    approvals: Approvals;
    watches: JigApi["watches"];
    /** The masker for today. Throws if masking cannot be done. */
    masker(): Masker;
    /** The merged configuration. Rebuilt when something changes it. */
    policy(): Policy;
    invalidatePolicy(): void;
    /** The last time writing a record failed, for `/jig`. */
    recordsProblem: string | undefined;
    /** Problems from loading that are not configuration, such as a plugin whose start-up callback threw. */
    startupProblems: string[];
}

/** Most calls remembered at once. A call whose end event never comes would otherwise stay for ever. */
export const MAX_OPEN_CALLS = 1000;

export function createState(pi: ExtensionAPI, options: JigCoreOptions = {}): JigState {
    const now = options.now ?? (() => new Date());
    const redactor = createRedactor();
    const makeMasker = options.createMasker ?? ((dir, date) => createMasker(dailyMaskKey(dir, date)));

    // The mask tokens stay the same all day, so the masker is made once per UTC day.
    let maskerDay: string | undefined;
    let maskerToday: Masker | undefined;

    let policy: Policy | undefined;

    const state: JigState = {
        pi,
        now,
        declarations: new Map(),
        personal: { file: "", found: false, config: defaultConfig(), problems: [], sections: new Map() },
        company: emptyAdditions(),
        sectionChecks: new Map(),
        configPath: () => "",
        configLoaded: false,
        sessionId: undefined,
        ticket: undefined,
        sessionAllows: new Set(),
        calls: new Map(),
        redactor,
        secrets: createSecrets({ backends: () => state.personal.config.secrets.backends, redactor }),
        approvals: createApprovals({
            now: () => Date.now(),
            openPreview: options.openPreview ?? (async (preview, header) => openInBrowser(writePreviewPage(preview, header))),
        }),
        watches: createWatchPlaceholder(),
        masker() {
            const date = now();
            const day = date.toISOString().slice(0, 10);
            if (maskerToday === undefined || maskerDay !== day) {
                maskerToday = makeMasker(stateDir(), date);
                maskerDay = day;
            }
            return maskerToday;
        },
        policy() {
            policy ??= buildPolicy(state.personal, state.company);
            return policy;
        },
        invalidatePolicy() {
            policy = undefined;
        },
        recordsProblem: undefined,
        startupProblems: [],
    };
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
    state.personal = loadConfigFile(file, state.sectionChecks);
    state.configLoaded = true;
    state.invalidatePolicy();
}

/** Reads jig.json now if nothing has yet. A plugin that is loaded before jig-core runs its `session_start` handler
 *  before jig-core's, and asking for its section there must not depend on that order. */
export function ensureConfigLoaded(state: JigState): void {
    if (!state.configLoaded && state.configPath() !== "") loadPersonalConfig(state);
}
