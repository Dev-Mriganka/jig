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
import { errorMessage } from "./errors.ts";
import { createMasker, dailyMaskKey } from "./mask/index.ts";
import type { Masker } from "./mask/index.ts";
import { stateDir } from "./paths.ts";
import { openInBrowser, writePreviewPage } from "./preview-html.ts";
import { createRedactor } from "./redact.ts";
import type { Redactor } from "./redact.ts";
import type { Answer, ErrorKind } from "./records.ts";
import { createSecrets } from "./secrets.ts";
import type { Secrets } from "./secrets.ts";
import { createSignIn } from "./signin.ts";
import type { SignIn } from "./signin.ts";
import { createWatchPlaceholder } from "./watch-placeholder.ts";

/** What a test (or an embedding program) can replace. A real Pi session uses the defaults. */
export interface JigCoreOptions {
    /** Makes the masker for a day, with the field names company plugins added. The default masks with the key of
     *  that day. */
    createMasker?: (stateDir: string, now: Date, extraFields: readonly string[]) => Masker;
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
    signIn: SignIn;
    approvals: Approvals;
    watches: JigApi["watches"];
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
    const makeMasker = options.createMasker ??
        ((dir, date, extraFields) => createMasker(dailyMaskKey(dir, date), { extraFields }));

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
        signIn: createSignIn({ redactor }),
        approvals: createApprovals({
            now: () => Date.now(),
            openPreview: options.openPreview ?? (async (preview, header) => openInBrowser(writePreviewPage(preview, header))),
        }),
        watches: createWatchPlaceholder(),
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
