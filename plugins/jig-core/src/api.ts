// The API other plugins reach through `jig()` (see client.ts and contract.ts). Each function is a thin step onto the
// state the hooks work on.
import {
    addCompanyClassifyRules,
    addCompanyEnvironments,
    addCompanyProtectedPaths,
    addCompanyRules,
    addCompanySecretBackends,
    addCompanySecretCommands,
    OWN_SECTIONS,
} from "./config.ts";
import type { Facts, JigApi, SandboxProvider } from "./contract.ts";
import { git, run, setCredentialRegistrar } from "./exec.ts";
import { TOOLS_SECTION } from "./kit/tools.ts";
import type { ExecGuard } from "./exec.ts";
import { checkOnboarding } from "./onboarding.ts";
import { newCompanyEntry, refreshCompany } from "./profile-state.ts";
import type { CompanyEntry } from "./profile-state.ts";
import { PROFILE_SECTION, PROFILES_SECTION } from "./profiles.ts";
import { ensureConfigLoaded, loadPersonalConfig } from "./state.ts";
import type { JigState } from "./state.ts";
import { oneOfProblem } from "./section-defaults.ts";
import { callRecord, writeRecord } from "./records.ts";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

/** Refuses a section option that must be a list of non-empty paths, such as `first` or `union`. */
function checkPathList(value: unknown, section: string, option: string, example: string): void {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || path === "")) {
        throw new TypeError(`registerSection(${section}): ${option} must be a list of paths such as ${example}`);
    }
}

/** The longest a command run in the sandbox for a plugin may take. */
const MAX_SANDBOX_RUN_MS = 2 * 60 * 60 * 1000;

/** Whether the registered sandbox is on and can run a command. A provider that throws when asked counts as one that cannot. */
function sandboxCanRun(state: JigState): boolean {
    const provider = state.sandbox;
    if (provider === undefined || typeof provider.run !== "function") return false;
    try {
        return provider.active === true;
    } catch {
        return false;
    }
}

export function buildApi(state: JigState): JigApi {
    // A token jig-core attaches to one call is redacted from every result, like a resolved secret.
    setCredentialRegistrar((value) => state.redactor.register(value));
    // Asked at each use: the sandbox registers after this API is built, and can be switched off and on.
    const guard: ExecGuard = {
        writable(real) {
            const provider = state.sandbox;
            if (provider === undefined || !provider.active) return false;
            try {
                return provider.canWrite(real);
            } catch {
                // A sandbox that cannot answer is treated as one that lets bash write: the program is refused.
                return true;
            }
        },
    };
    const profiles: NonNullable<JigApi["profiles"]> = {
        register(name, options) {
            if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
                throw new TypeError("profiles.register: the name is letters, digits, dots, dashes and underscores");
            }
            if (typeof options?.displayName !== "string" || options.displayName.trim() === "") {
                throw new TypeError(`profiles.register(${name}): displayName must be text`);
            }
            if (
                options.overlays !== undefined &&
                (typeof options.overlays !== "string" || !isAbsolute(options.overlays))
            ) {
                throw new TypeError(`profiles.register(${name}): overlays must be an absolute folder`);
            }
            if (
                options.skills !== undefined &&
                (!Array.isArray(options.skills) || options.skills.some((skill) => typeof skill !== "string"))
            ) {
                throw new TypeError(`profiles.register(${name}): skills must be a list of skill names`);
            }
            if (options.onChange !== undefined && typeof options.onChange !== "function") {
                throw new TypeError(`profiles.register(${name}): onChange must be a function`);
            }
            const entry = newCompanyEntry(name, options.displayName.trim());
            entry.overlays = options.overlays;
            entry.skills = [...(options.skills ?? [])];
            entry.onChange = options.onChange;
            state.companies.set(name, entry);
            // The choice may be a different one now that this company can be chosen.
            if (state.configLoaded) loadPersonalConfig(state, state.personal.file);
            return scoped(api, state, entry);
        },
        active() {
            const { reason, profile, plugin, why } = state.profile.selection;
            return {
                reason,
                why,
                ...(profile === undefined ? {} : { profile }),
                ...(plugin === undefined ? {} : { plugin }),
            };
        },
    };
    const api: JigApi = {
        version: 1,
        profiles,

        declareTool(declaration) {
            // A declaration is code from another package. Check its shape here, so a mistake fails where it is made
            // and not in the middle of somebody's tool call.
            if (typeof declaration?.tool !== "string" || declaration.tool === "") {
                throw new TypeError("declareTool: the tool needs a name");
            }
            if (typeof declaration.plugin !== "string" || declaration.plugin === "") {
                throw new TypeError(`declareTool(${declaration.tool}): the plugin needs a name`);
            }
            if (typeof declaration.classify !== "function") {
                throw new TypeError(`declareTool(${declaration.tool}): classify must be a function`);
            }
            state.declarations.set(declaration.tool, declaration);
        },

        tools: {
            declared: () =>
                [...state.declarations.values()].map((declaration) => ({
                    tool: declaration.tool,
                    plugin: declaration.plugin,
                })),
        },

        approvedPreview: (toolCallId) => state.calls.get(toolCallId)?.approvedPreview,

        addFacts(toolCallId: string, facts: Facts) {
            // Cleaned when the record is written; a call that has ended has nothing left to add to.
            const call = state.calls.get(toolCallId);
            if (call !== undefined) Object.assign(call.facts, facts);
        },

        setTicket(key) {
            state.ticket = key === undefined || key === "" ? undefined : key;
        },

        secrets: {
            resolve: (ref, signal) => state.secrets.resolve(ref, signal),
        },

        environments: {
            kindOf: (name) => state.policy().environments.kindOf(name),
            list: () => state.policy().environments.list(),
        },

        tunnels: {
            register: (name, provider) => state.tunnels.register(name, provider),
            open: (name, target, signal) => state.tunnels.open(name, target, signal),
        },

        transports: {
            register: (name, transport) => state.transports.register(name, transport),
            request: (name, request, signal) => state.transports.request(name, request, signal),
        },

        signIn: {
            register: (name, service) => state.signIn.register(name, service),
            headers: (name, request, signal) => state.signIn.headers(name, request, signal),
        },

        http: { request: (request, signal) => state.http.request(request, signal) },

        mask: {
            text: (input) => state.masker().text(input),
            value: <T>(input: T): T => state.masker().value(input),
        },

        // Only the contract's four calls: the rest of the engine belongs to jig-core.
        watches: {
            registerKind: (kind) => state.watches.registerKind(kind),
            start: (watch) => state.watches.start(watch),
            list: () => state.watches.list(),
            stop: (id) => state.watches.stop(id),
        },

        config: {
            addEnvironments(environments) {
                addCompanyEnvironments(state.globalCompany, environments);
                refreshCompany(state);
            },
            addRules(rules) {
                addCompanyRules(state.globalCompany, rules);
                refreshCompany(state);
            },
            addClassifyRules(rules) {
                addCompanyClassifyRules(state.globalCompany, rules);
                refreshCompany(state);
            },
            addProtectedPaths(paths) {
                addCompanyProtectedPaths(state.globalCompany, paths);
                refreshCompany(state);
            },
            addSecretCommands(commands) {
                addCompanySecretCommands(state.globalCompany, commands);
                refreshCompany(state);
            },
            enableSecretBackends(backends) {
                // Read at each resolve, so there is no policy to rebuild.
                addCompanySecretBackends(state.globalCompany, backends);
                refreshCompany(state);
            },
            addMaskFields: (fields) => state.addMaskFields(fields),
            registerSection(name, validate, options) {
                if (typeof name !== "string" || name === "")
                    throw new TypeError("registerSection: the section needs a name");
                if (typeof validate !== "function")
                    throw new TypeError(`registerSection(${name}): validate must be a function`);
                const replace = options?.replace;
                if (
                    replace !== undefined &&
                    (!Array.isArray(replace) || replace.some((path) => typeof path !== "string" || path === ""))
                ) {
                    throw new TypeError(
                        `registerSection(${name}): replace must be a list of paths such as "auth" or "services.*.ci.auth"`,
                    );
                }
                const union = options?.union;
                if (
                    union !== undefined &&
                    (!Array.isArray(union) || union.some((path) => typeof path !== "string" || path === ""))
                ) {
                    throw new TypeError(
                        `registerSection(${name}): union must be a list of paths such as "folders" or "services.*.hosts"`,
                    );
                }
                const first = options?.first;
                checkPathList(first, name, "first", '"accounts" or "services.*.hosts"');
                const oneOf = options?.oneOf;
                if (oneOf !== undefined) {
                    if (!Array.isArray(oneOf)) throw new TypeError(`registerSection(${name}): oneOf must be a list`);
                    for (const paths of oneOf) {
                        const problem = oneOfProblem(paths);
                        if (problem !== undefined) throw new TypeError(`registerSection(${name}): ${problem}`);
                    }
                }
                // The names jig-core reads itself stay its own: a plugin could otherwise take over `rules`.
                if (OWN_SECTIONS.includes(name)) {
                    throw new Error(
                        `registerSection: "${name}" is a jig-core field, so a plugin cannot use it for a section`,
                    );
                }
                if (name === TOOLS_SECTION || name === PROFILES_SECTION || name === PROFILE_SECTION) {
                    throw new Error(`registerSection: "${name}" is jig-core's section, so a plugin cannot use it`);
                }
                state.sectionChecks.set(name, validate);
                if (oneOf === undefined || oneOf.length === 0) state.sectionOneOf.delete(name);
                else
                    state.sectionOneOf.set(
                        name,
                        oneOf.map((paths) => [...paths]),
                    );
                // Registering again replaces what the first call said, the keys that replace and the lists that add up included.
                if (replace === undefined || replace.length === 0) state.sectionReplace.delete(name);
                else state.sectionReplace.set(name, [...replace]);
                if (union === undefined || union.length === 0) state.sectionUnion.delete(name);
                else state.sectionUnion.set(name, [...union]);
                if (first === undefined || first.length === 0) state.sectionFirst.delete(name);
                else state.sectionFirst.set(name, [...first]);
                // A section registered after the file was read is checked now, so the order plugins load in does not matter.
                if (state.configLoaded) loadPersonalConfig(state, state.personal.file);
            },
            addSectionDefaults(name, defaults) {
                if (typeof name !== "string" || name === "")
                    throw new TypeError("addSectionDefaults: the section needs a name");
                if (OWN_SECTIONS.includes(name) || name === PROFILES_SECTION || name === PROFILE_SECTION) {
                    throw new Error(`addSectionDefaults: "${name}" is a jig-core field, not a plugin's section`);
                }
                state.sectionDefaults.set(name, defaults);
                // Your section was checked alone if it was read before the defaults came; it is checked over them now.
                if (state.configLoaded) loadPersonalConfig(state, state.personal.file);
            },
            section(name) {
                ensureConfigLoaded(state);
                return state.personal.sections.get(name);
            },
        },

        protectedPaths: {
            list: () => state.policy().protectedPaths.map((entry) => ({ ...entry })),
        },

        sandbox: {
            register(provider) {
                if (typeof provider?.canWrite !== "function") {
                    throw new TypeError("sandbox.register: the provider needs a canWrite function");
                }
                state.sandbox = provider;
            },
            get canRun() {
                return sandboxCanRun(state);
            },
            async run(command, options) {
                // Checked here and not left to the provider: a plugin that asks for the sandbox must never get a command run
                // anywhere else, whatever the provider does with a request it cannot honour.
                if (!sandboxCanRun(state)) {
                    throw new Error(
                        "no sandbox can run this command: none is registered, it is switched off, it could not start, or it cannot run commands",
                    );
                }
                if (typeof command !== "string" || command === "" || command.includes("\0")) {
                    throw new TypeError("sandbox.run: the command must be text");
                }
                if (typeof options?.cwd !== "string" || !isAbsolute(options.cwd)) {
                    throw new TypeError("sandbox.run: cwd must be an absolute path");
                }
                const timeoutMs = options.timeoutMs;
                if (
                    timeoutMs !== undefined &&
                    (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SANDBOX_RUN_MS)
                ) {
                    throw new TypeError("sandbox.run: timeoutMs must be from 1 ms to 2 hours");
                }
                return (state.sandbox as Required<SandboxProvider>).run(command, options);
            },
        },

        markRefused: (toolCallId) => state.refusedCalls.add(toolCallId),
        takeRefused: (toolCallId) => state.refusedCalls.delete(toolCallId),

        gates: {
            register: (gate) => state.gates.register(gate),
        },

        approvals: {
            inTurn: (job) => state.approvals.inTurn(job),
        },

        status: {
            register(plugin, lines) {
                if (typeof plugin !== "string" || plugin === "") {
                    throw new TypeError("status.register: the plugin needs a name");
                }
                if (typeof lines !== "function")
                    throw new TypeError(`status.register(${plugin}): lines must be a function`);
                state.statusLines.set(plugin, lines);
            },
        },

        onboarding: {
            register: (entry) => {
                state.onboarding = checkOnboarding(entry);
            },
        },

        exec: {
            run: (file, args, options) => run(file, args, options, guard),
            git: (repo, args, options) => git(repo, args, options, guard),
        },
        records: {
            recall: ({ tool, action, plugin, ticket, entries, queries = 1 }) => {
                try {
                    const now = new Date();
                    const count = Number.isFinite(entries) ? Math.max(0, Math.floor(entries)) : 0;
                    const asked = Number.isFinite(queries) ? Math.max(0, Math.floor(queries)) : 1;
                    writeRecord(
                        callRecord(
                            {
                                session: state.sessionId ?? "unknown",
                                ...(ticket === undefined ? {} : { ticket }),
                                tool,
                                action,
                                plugin,
                                environment: "local",
                                environmentKind: "local",
                                effect: "read",
                                decision: "allow",
                                decisionSource: "tool",
                                outcome: "ok",
                                toolCallId: `record-${randomUUID()}`,
                                facts: { entries: count, queries: asked },
                            },
                            now,
                        ),
                        now,
                    );
                } catch {
                    // A record that cannot be written must not break the message.
                }
            },
        },
    };

    return api;
}

/** The API as one company plugin sees it: what it adds belongs to its company, and applies while that company is active. */
function scoped(api: JigApi, state: JigState, entry: CompanyEntry): JigApi {
    const mine = (): boolean => state.companies.get(entry.name) === entry;
    const settle = (): void => {
        // A registration that was replaced no longer counts.
        if (mine()) refreshCompany(state);
    };
    return {
        ...api,
        config: {
            ...api.config,
            addEnvironments(environments) {
                addCompanyEnvironments(entry.additions, environments);
                settle();
            },
            addRules(rules) {
                addCompanyRules(entry.additions, rules);
                settle();
            },
            addClassifyRules(rules) {
                addCompanyClassifyRules(entry.additions, rules);
                settle();
            },
            addSecretCommands(commands) {
                addCompanySecretCommands(entry.additions, commands);
                settle();
            },
            enableSecretBackends(backends) {
                addCompanySecretBackends(entry.additions, backends);
                settle();
            },
            addSectionDefaults(name, defaults) {
                if (typeof name !== "string" || name === "")
                    throw new TypeError("addSectionDefaults: the section needs a name");
                if (OWN_SECTIONS.includes(name) || name === PROFILES_SECTION || name === PROFILE_SECTION) {
                    throw new Error(`addSectionDefaults: "${name}" is a jig-core field, not a plugin's section`);
                }
                entry.defaults.set(name, defaults);
                if (state.configLoaded && mine()) loadPersonalConfig(state, state.personal.file);
            },
        },
        status: {
            register(plugin, lines) {
                if (typeof plugin !== "string" || plugin === "") {
                    throw new TypeError("status.register: the plugin needs a name");
                }
                if (typeof lines !== "function")
                    throw new TypeError(`status.register(${plugin}): lines must be a function`);
                entry.statusLines.set(plugin, lines);
            },
        },
        onboarding: {
            register: (list) => {
                entry.onboarding = checkOnboarding(list);
            },
        },
    };
}
