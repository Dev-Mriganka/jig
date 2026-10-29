// The API other plugins reach through `jig()` (see client.ts and contract.ts). Each function is a thin step onto the
// state the hooks work on.
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

        mask: {
            text: (input) => state.masker().text(input),
            value: <T>(input: T): T => state.masker().value(input),
        },

        watches: state.watches,

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
            registerSection(name, validate) {
                if (typeof name !== "string" || name === "") throw new TypeError("registerSection: the section needs a name");
                if (typeof validate !== "function") throw new TypeError(`registerSection(${name}): validate must be a function`);
                // The names jig-core reads itself stay its own: a plugin could otherwise take over `rules`.
                if (OWN_SECTIONS.includes(name)) {
                    throw new Error(`registerSection: "${name}" is a jig-core field, so a plugin cannot use it for a section`);
                }
                state.sectionChecks.set(name, validate);
                // A section registered after the file was read is checked now, so the order plugins load in does not matter.
                if (state.configLoaded) loadPersonalConfig(state, state.personal.file);
            },
            section(name) {
                ensureConfigLoaded(state);
                return state.personal.sections.get(name);
            },
        },

        exec: { run, git },
    };
}
