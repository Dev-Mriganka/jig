// The API other plugins reach through `jig()` (see client.ts and contract.ts). Each function is a thin step onto the
// state the hooks work on.
import {
    addCompanyClassifyRules,
    addCompanyEnvironments,
    addCompanyProtectedPaths,
    addCompanyRules,
    addCompanySecretCommands,
    OWN_SECTIONS,
} from "./config.ts";
import type { Facts, JigApi } from "./contract.ts";
import { git, run } from "./exec.ts";
import type { ExecGuard } from "./exec.ts";
import { ensureConfigLoaded, loadPersonalConfig } from "./state.ts";
import type { JigState } from "./state.ts";
import { oneOfProblem } from "./section-defaults.ts";

export function buildApi(state: JigState): JigApi {
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
    return {
        version: 1,

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
                addCompanyEnvironments(state.company, environments);
                state.invalidatePolicy();
            },
            addRules(rules) {
                addCompanyRules(state.company, rules);
                state.invalidatePolicy();
            },
            addClassifyRules(rules) {
                addCompanyClassifyRules(state.company, rules);
                state.invalidatePolicy();
            },
            addProtectedPaths(paths) {
                addCompanyProtectedPaths(state.company, paths);
                state.invalidatePolicy();
            },
            addSecretCommands(commands) {
                addCompanySecretCommands(state.company, commands);
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
                state.sectionChecks.set(name, validate);
                if (oneOf === undefined || oneOf.length === 0) state.sectionOneOf.delete(name);
                else
                    state.sectionOneOf.set(
                        name,
                        oneOf.map((paths) => [...paths]),
                    );
                // Registering again replaces what the first call said, the keys that replace included.
                if (replace === undefined || replace.length === 0) state.sectionReplace.delete(name);
                else state.sectionReplace.set(name, [...replace]);
                // A section registered after the file was read is checked now, so the order plugins load in does not matter.
                if (state.configLoaded) loadPersonalConfig(state, state.personal.file);
            },
            addSectionDefaults(name, defaults) {
                if (typeof name !== "string" || name === "")
                    throw new TypeError("addSectionDefaults: the section needs a name");
                if (OWN_SECTIONS.includes(name)) {
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

        exec: {
            run: (file, args, options) => run(file, args, options, guard),
            git: (repo, args, options) => git(repo, args, options, guard),
        },
    };
}
