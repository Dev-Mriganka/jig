// The command `/api refresh [collection]`: fetches the collections that are kept in a service (Postman's cloud) to their local copy,
// and says what changed. It is the person's command, typed by them, and fetches with the key that jig-core reads for it; the
// agent cannot run it. The fetch goes through the sending engine, so a company transport or sign-in service carries it.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import { settingsOf } from "./config.ts";
import type { ApiSettings } from "./config.ts";
import { createHttp } from "./engine/http.ts";
import { errorMessage, shortList } from "./engine/values.ts";
import type { ApiOptions } from "./tool.ts";

const USAGE = "Usage: /api refresh [collection]: fetch the Postman cloud collections to their local copy";

/** What the command says, for the collections it was asked to refresh. Pure of the screen, so a test can read it. */
export async function refreshCollections(
    settings: ApiSettings,
    wanted: string | undefined,
    options: ApiOptions,
    signal: AbortSignal | undefined,
): Promise<{ lines: string[]; failed: boolean }> {
    const fetchable = [...settings.collections.values()].filter((collection) => collection.refresher !== undefined);
    if (wanted !== undefined) {
        const found = settings.collections.get(wanted);
        if (found === undefined) {
            const known = shortList([...settings.collections.keys()], ", ", 80);
            return { lines: [`No collection is named ${wanted}. Known: ${known}`], failed: true };
        }
        if (found.refresher === undefined) {
            const names = fetchable.map((each) => each.name).join(", ") || "none";
            return {
                lines: [
                    `${wanted} is read from files, so there is nothing to fetch. Collections that can be fetched: ${names}`,
                ],
                failed: true,
            };
        }
    }
    const chosen = fetchable.filter((collection) => wanted === undefined || collection.name === wanted);
    if (chosen.length === 0) {
        const how = '{ "postman": { "cloud": "<id>", "apiKey": "<secret reference>" } }';
        return {
            lines: [`No collection is a Postman cloud collection: add one under api.collections as ${how}`],
            failed: true,
        };
    }

    const http = createHttp(options);
    const deps = {
        http,
        timeoutSec: settings.timeoutSec,
        allowPlainLocal: settings.allowPlainLocal,
        serviceUrl: options.postmanApi,
    };
    const lines: string[] = [];
    let failed = false;
    for (const collection of chosen) {
        try {
            const report = await collection.refresher?.run(deps, signal);
            if (report === undefined) continue;
            lines.push(...report.lines);
            failed ||= report.failed;
        } catch (error) {
            // The engine and the source report what they know. This is for what they did not expect.
            lines.push(
                `${collection.name}: the refresh stopped (${errorMessage(error).replace(/\s+/g, " ").slice(0, 120)})`,
            );
            failed = true;
        }
    }
    return { lines, failed };
}

export function registerRefresh(pi: ExtensionAPI, options: ApiOptions): void {
    pi.registerCommand("api", {
        description: "jig-api: /api refresh [collection] fetches Postman cloud collections to a local copy",
        getArgumentCompletions: (prefix) => {
            const matches = ["refresh"].filter((word) => word.startsWith(prefix));
            return matches.length === 0 ? null : matches.map((word) => ({ value: word, label: word }));
        },
        handler: async (args: string, ctx: ExtensionCommandContext) => {
            const [word, wanted, ...rest] = args
                .trim()
                .split(/\s+/)
                .filter((part) => part !== "");
            if (word !== "refresh" || rest.length > 0) {
                ctx.ui.notify(USAGE, "warning");
                return;
            }
            const settings = settingsOf(jig().config.section("api"));
            if (settings === undefined) {
                const how = 'add an "api" section with "collections" to jig.json (/jig lists configuration problems)';
                ctx.ui.notify(`api is not set up: ${how}`, "warning");
                return;
            }
            const report = await refreshCollections(settings, wanted, options, ctx.signal);
            ctx.ui.notify(report.lines.join("\n"), report.failed ? "warning" : "info");
        },
    });
}
