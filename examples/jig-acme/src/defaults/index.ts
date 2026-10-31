// The company's defaults for each plugin's section of jig.json. A company plugin cannot write the user's file, so it gives defaults,
// and the user's own section is laid over them: objects merge key by key, and any other value of the user's (a list, a string, a
// number) replaces the company's. A plugin names the keys where an object is one choice among several (an `auth` of `{ signIn }` or
// of `{ token }`): there the user's replaces the company's whole, and the two never make a mix.
//
// The values are plain data in the shape each plugin documents (its README, "Configure"). Nothing here imports a plugin: the
// plugin checks the result, with the user's section laid over it, when a session starts.
import type { JigApi } from "../jig/types.ts";
import { apiDefaults } from "./api.ts";
import { gitDefaults } from "./git.ts";
import { jiraDefaults } from "./jira.ts";
import { logsDefaults } from "./logs.ts";
import { memoryDefaults } from "./memory.ts";
import { mongoDefaults } from "./mongo.ts";
import { opsDefaults } from "./ops.ts";
import { sandboxDefaults } from "./sandbox.ts";
import { themeDefaults } from "./theme.ts";

/** The defaults by the name of the section they are for. */
export const DEFAULTS: Readonly<Record<string, unknown>> = {
    jira: jiraDefaults,
    logs: logsDefaults,
    mongo: mongoDefaults,
    api: apiDefaults,
    ops: opsDefaults,
    memory: memoryDefaults,
    git: gitDefaults,
    theme: themeDefaults,
    sandbox: sandboxDefaults,
};

export function registerDefaults(api: JigApi): void {
    for (const [section, defaults] of Object.entries(DEFAULTS)) api.config.addSectionDefaults(section, defaults);
}
