// The plan for a new issue. Everything the person approves is built here from the project's create screen, so the
// preview, the duplicate check and the request agree: field names are resolved to ids on the screen, values are checked
// against what the screen allows, and a required field that is missing is a mistake in the call, found before anyone is
// asked.
import { search } from "./api.ts";
import type { Env } from "./api.ts";
import { checkAllowed, expectation, missingRequired, readScreen, screenField } from "./create-meta.ts";
import type { Screen } from "./create-meta.ts";
import { convertField, isWikiField, knownFieldId } from "./fields.ts";
import type { Converted } from "./fields.ts";
import { LostReplyError } from "./http.ts";
import type { CallOf, Plan } from "./plan.ts";
import { assigneeValue } from "./plan-fields.ts";
import { pointersIn, stringsIn } from "./pointers.ts";
import { errorMessage, InputError, nameOf, obj, oneLine, shortList, str } from "./values.ts";

const DUPLICATE_DAYS = 30;
const MAX_DUPLICATES = 5;
/** What the re-read after a lost reply looks back over. */
const RECHECK_MINUTES = 10;

/** The words of a summary that a text search is given: letters and digits only, so nothing in it is search syntax. */
const searchWords = (summary: string): string =>
    summary
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .slice(0, 100);

/** Issues like this one, created in the project lately, for the person to see before a duplicate is made. */
async function duplicateNotes(env: Env, project: string, summary: string): Promise<string[]> {
    const words = searchWords(summary);
    if (words === "") return ["Possible duplicates: not checked, the summary has no words to search for."];
    const lately = `in ${project} in the last ${DUPLICATE_DAYS} days`;
    try {
        const page = await search(env, {
            jql: `project = "${project}" AND created >= -${DUPLICATE_DAYS}d AND summary ~ "${words}"`,
            fields: ["summary", "status"],
            limit: MAX_DUPLICATES,
        });
        if (page.issues.length === 0) return [`Possible duplicates: none among the issues created ${lately}.`];
        return [
            `Possible duplicates, created ${lately}:`,
            ...page.issues.map((issue) => {
                const fields = obj(issue.fields);
                return `  ${str(issue.key)} [${nameOf(fields.status)}] ${oneLine(str(fields.summary), 100)}`;
            }),
        ];
    } catch (error) {
        // A failed search is no reason to stop, but the person must know it did not happen.
        const why = oneLine(errorMessage(error), 120);
        return [`Possible duplicates: the search failed (${why}). Look in ${project} yourself.`];
    }
}

interface Given {
    id: string;
    name: string;
    converted: Converted;
    /** True when the value is the person's configured default, not something the call set. */
    fromDefaults: boolean;
}

const FROM_DEFAULTS = "from your defaults";

/** The names of the fields a call may set: the project and the type are given by their own parameters. */
function screenNames(screen: Screen): string {
    const fields = [...screen.fields.values()].filter((field) => field.id !== "project" && field.id !== "issuetype");
    return shortList(
        fields.map((field) => field.name),
        ", ",
        80,
    );
}

export async function planCreate(env: Env, call: CallOf<"create">, preview: boolean): Promise<Plan> {
    const { settings } = env;
    const screen = await readScreen(env, call.project, call.type);
    const where = screen === undefined ? call.project : `${screen.type.name} in ${call.project}`;
    const given = new Map<string, Given>();

    /** The id of the field a name means: a known name, else a field on the screen by its name or id. */
    const lookup = (name: string): string | undefined => {
        const known = knownFieldId(name, settings.fields);
        if (screen === undefined) {
            if (known !== undefined) return known;
            return /^[A-Za-z][A-Za-z0-9_]*$/.test(name.trim()) ? name.trim() : undefined;
        }
        return screenField(screen, known ?? name)?.id;
    };
    const idOf = (name: string): string => {
        const id = lookup(name);
        if (id !== undefined) return id;
        throw new InputError(
            screen === undefined
                ? `jira create: "${name.slice(0, 40)}" is not a field name or id`
                : `jira create: "${name.slice(0, 40)}" is not on the create screen of ${where}; ` +
                      `its fields: ${screenNames(screen)}`,
        );
    };

    const add = async (name: string, id: string, raw: unknown, fromDefaults = false): Promise<void> => {
        if (id === "project" || id === "issuetype")
            throw new InputError(`jira create: ${id} is set by project and type`);
        if (given.has(id)) throw new InputError(`jira create: ${id} is given twice`);
        try {
            let converted =
                id === "assignee" ? await assigneeValue(env, { project: call.project }, raw) : convertField(id, raw);
            const field = screen?.fields.get(id);
            if (field !== undefined) converted = checkAllowed(field, converted);
            // The screen's own name for a field is the clearest label; without a screen, the name the call used.
            given.set(id, { id, name: field?.name ?? name, converted, fromDefaults });
        } catch (error) {
            if (!(error instanceof InputError)) throw error;
            // A default is not something the call wrote, so the message says where it comes from and how to override it.
            const origin = fromDefaults
                ? ` (the value of "${name.slice(0, 40)}" in createDefaults in jig.json; set that field in the call to use another)`
                : "";
            throw new InputError(`jira create: ${error.message}${origin}`);
        }
    };

    await add("summary", "summary", call.summary);
    if (call.description !== undefined) await add("description", "description", call.description);
    for (const [name, raw] of Object.entries(call.fields)) await add(name, idOf(name), raw);

    // The person's defaults fill the fields the call left alone, and may satisfy a field the screen requires. A default
    // for a field that is not on this screen is left out and said so, because it was meant for every create.
    const notApplied: string[] = [];
    for (const [name, raw] of Object.entries(settings.createDefaults)) {
        const id = lookup(name);
        if (id === undefined) {
            notApplied.push(name);
        } else if (given.get(id)?.fromDefaults === true) {
            throw new InputError(
                `jira create: createDefaults names ${id} twice, as "${name.slice(0, 40)}" and another`,
            );
        } else if (!given.has(id)) {
            await add(name, id, raw, true);
        }
    }

    if (screen !== undefined) {
        const missing = missingRequired(screen, new Set(given.keys()));
        if (missing.length > 0) {
            const needed = shortList(
                missing.map((field) => `${field.name} (${expectation(field)})`),
                "; ",
                110,
            );
            throw new InputError(`jira create: ${where} also needs ${needed}; pass them in fields`);
        }
    }

    const fields = {
        project: { key: call.project },
        issuetype: screen === undefined ? { name: call.type } : { id: screen.type.id },
        ...Object.fromEntries([...given.values()].map((field) => [field.id, field.converted.send])),
    };
    const summary = String(given.get("summary")?.converted.send ?? call.summary);
    const textual = (field: Given): boolean => isWikiField(field.id) && typeof field.converted.send === "string";

    const notes = preview ? await duplicateNotes(env, call.project, summary) : [];
    if (notApplied.length > 0) {
        const names = notApplied.map((name) => `"${name.slice(0, 40)}"`).join(", ");
        notes.push(
            `Defaults not applied: ${names} ${notApplied.length === 1 ? "is" : "are"} not on the create screen of ${where}.`,
        );
    }
    if (screen === undefined) {
        notes.push(
            "The create screen could not be read, so the values are shown as given " +
                "and Jira checks them when it creates the issue.",
        );
    }
    const shownFields = [...given.values()];
    const fact = (field: Given): [string, string] => [
        field.name,
        field.fromDefaults ? `${field.converted.shown} (${FROM_DEFAULTS})` : field.converted.shown,
    ];
    const text = (field: Given): { label: string; source: string } => ({
        label: field.fromDefaults ? `${field.name} (${FROM_DEFAULTS})` : field.name,
        source: String(field.converted.send),
    });

    return {
        key: undefined,
        shown: {
            summary: `Create a ${screen?.type.name ?? call.type} in ${call.project}: "${oneLine(summary, 80)}"`,
            flags: pointersIn(stringsIn(fields), settings.privateNames),
            rows: [
                ["Project", call.project],
                ["Type", screen?.type.name ?? call.type],
                ...shownFields.filter((field) => !textual(field)).map(fact),
            ],
            notes,
            texts: shownFields.filter(textual).map(text),
        },
        send: { method: "POST", path: "/issue", body: { fields } },
        basis: {},
        async check() {
            const words = searchWords(summary);
            const page = await search(env, {
                jql:
                    `project = "${call.project}" AND created >= -${RECHECK_MINUTES}m` +
                    (words === "" ? "" : ` AND summary ~ "${words}"`),
                fields: ["summary", "status"],
                limit: 20,
            });
            const wanted = oneLine(summary, 300).toLowerCase();
            const same = page.issues.filter(
                (issue) => oneLine(str(obj(issue.fields).summary), 300).toLowerCase() === wanted,
            );
            const [first] = same;
            const created = `created in the last ${RECHECK_MINUTES} minutes`;
            if (first === undefined) {
                return {
                    happened: false,
                    text: `no issue in ${call.project} with exactly this summary was ${created}`,
                };
            }
            const keys = same.map((issue) => str(issue.key)).join(", ");
            return {
                happened: true,
                key: str(first.key),
                text: `${keys} in ${call.project} has exactly this summary and was ${created}`,
            };
        },
        done(reply) {
            const key = str(obj(reply).key);
            if (key === "") throw new LostReplyError("Jira's answer had no issue key");
            return { text: `Created ${key}: ${oneLine(summary, 120)}\n${settings.site}/browse/${key}`, key };
        },
    };
}
