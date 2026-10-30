// The API other plugins reach through `jig()` (see client.ts and contract.ts). Each function is a thin step onto the
// state the hooks work on.
import { layered } from "./section-defaults.ts";
import { addCompanyClassifyRules, addCompanyEnvironments, addCompanyRules, OWN_SECTIONS } from "./config.ts";
import type { Facts, JigApi } from "./contract.ts";
import { git, run } from "./exec.ts";
import { ensureConfigLoaded, loadPersonalConfig } from "./state.ts";
import type { JigState } from "./state.ts";

export function buildApi(state: JigState): JigApi {
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
            addMaskFields: (fields) => state.addMaskFields(fields),
            registerSection(name, validate) {
                if (typeof name !== "string" || name === "")
                    throw new TypeError("registerSection: the section needs a name");
                if (typeof validate !== "function")
                    throw new TypeError(`registerSection(${name}): validate must be a function`);
                // The names jig-core reads itself stay its own: a plugin could otherwise take over `rules`.
                if (OWN_SECTIONS.includes(name)) {
                    throw new Error(
                        `registerSection: "${name}" is a jig-core field, so a plugin cannot use it for a section`,
                    );
                }
                state.sectionChecks.set(name, validate);
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
            },
            section(name) {
                ensureConfigLoaded(state);
                const mine = state.personal.sections.get(name);
                if (!state.sectionDefaults.has(name)) return mine;
                const merged = layered(state.sectionDefaults.get(name), mine);
                const check = state.sectionChecks.get(name);
                const problems = check === undefined ? [] : check(merged);
                if (problems.length === 0) return merged;
                // The company's defaults and your settings do not fit together: your own section, as you wrote it, wins.
                const report = `the company defaults for "${name}", with your settings laid over them, are not valid: ${problems.join("; ")}`;
                if (!state.sectionDefaultProblems.has(report)) {
                    state.sectionDefaultProblems.add(report);
                    state.startupProblems.push(report);
                }
                return mine;
            },
        },

        exec: { run, git },
    };
}
