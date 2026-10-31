// The card file: front matter that the plugin fills in, then three short sections that the agent writes. The front
// matter is the part of YAML that JSON also is, one value per line (strings in double quotes, lists as `- "item"`), so
// any YAML reader accepts it and this file reads it without a library.
import { ERROR_LENGTH, MAX_ERRORS, MAX_IDENTIFIERS, MAX_KEYS } from "./extract.ts";

export const SECTIONS = ["Problem", "Cause", "Fix"] as const;
export type Section = (typeof SECTIONS)[number];
/** Characters in one section. */
export const SECTION_LIMIT = 400;
/** What a drafted section holds until the agent replaces it. */
export const PLACEHOLDER = "(not filled yet)";

export interface CardFront {
    ticket: string;
    closedAt: string;
    repositories: string[];
    keys: string[];
    identifiers: string[];
    errors: string[];
}

export type CardSections = Record<Section, string>;

const LIST_FIELDS = ["repositories", "keys", "identifiers", "errors"] as const;

const quote = (value: string) => JSON.stringify(value);

function renderList(name: string, items: readonly string[]): string {
    return items.length === 0 ? `${name}: []\n` : `${name}:\n${items.map((item) => `  - ${quote(item)}\n`).join("")}`;
}

/** The front matter block, from `---` to `---`. */
export function renderFront(front: CardFront): string {
    return [
        "---\n",
        `ticket: ${quote(front.ticket)}\n`,
        `closedAt: ${quote(front.closedAt)}\n`,
        renderList("repositories", front.repositories),
        renderList("keys", front.keys),
        renderList("identifiers", front.identifiers),
        renderList("errors", front.errors),
        "---\n",
    ].join("");
}

/** A whole card: the front matter and the sections, in order. */
export function renderCard(front: CardFront, sections: CardSections): string {
    return `${renderFront(front)}\n${SECTIONS.map((name) => `## ${name}\n${sections[name].trim()}\n`).join("\n")}`;
}

/** The card a close starts from: the front matter, and a placeholder in each section. */
export function draftCard(front: CardFront): string {
    return renderCard(front, { Problem: PLACEHOLDER, Cause: PLACEHOLDER, Fix: PLACEHOLDER });
}

/** One value of the front matter: JSON when it is JSON (a quoted string, a list), else the plain text after the colon. */
function scalar(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text.trim();
    }
}

/**
 * The front matter at the top of a card, or undefined when there is none that holds a `ticket` and a `closedAt`. A
 * list that is missing is empty; a list item that is not text is dropped; a list is cut to the length a card keeps.
 */
export function parseFront(text: string): { front: CardFront; end: number } | undefined {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines[0]?.trim() !== "---") return undefined;
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (close < 0) return undefined;
    const fields = new Map<string, unknown>();
    let list: unknown[] | undefined;
    for (const line of lines.slice(1, close)) {
        const item = /^\s+-\s+(.*)$/.exec(line);
        if (item !== null && list !== undefined) {
            list.push(scalar(item[1] ?? ""));
            continue;
        }
        const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
        if (field === null) continue;
        const [, name = "", value = ""] = field;
        if (value === "") {
            list = [];
            fields.set(name, list);
        } else {
            list = undefined;
            fields.set(name, scalar(value));
        }
    }
    const { ticket, closedAt } = Object.fromEntries(fields);
    if (typeof ticket !== "string" || ticket === "" || typeof closedAt !== "string" || closedAt === "")
        return undefined;
    const listOf = (name: (typeof LIST_FIELDS)[number], max: number, length: number): string[] => {
        const value = fields.get(name);
        return Array.isArray(value)
            ? value
                  .filter((entry): entry is string => typeof entry === "string" && entry !== "")
                  .map((entry) => entry.slice(0, length))
                  .slice(0, max)
            : [];
    };
    return {
        front: {
            ticket,
            closedAt,
            repositories: listOf("repositories", 20, 200),
            keys: listOf("keys", MAX_KEYS, 64),
            identifiers: listOf("identifiers", MAX_IDENTIFIERS, 200),
            errors: listOf("errors", MAX_ERRORS, ERROR_LENGTH),
        },
        end: close + 1,
    };
}

export interface CheckedCard {
    /** The front matter, when the file has a usable one. */
    front: CardFront | undefined;
    /** The text of each section that is present, trimmed. */
    sections: Partial<CardSections>;
    /** What is wrong with the sections, one line each, in words that tell the agent what to change. */
    problems: string[];
}

const characters = (text: string) => Array.from(text).length;

/** Reads a card and says what is wrong with its sections. The front matter is read, and judged by `isValid`. */
export function checkCard(text: string): CheckedCard {
    const parsed = parseFront(text);
    const body = text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .slice(parsed?.end ?? 0);
    const found = new Map<string, string[]>();
    const problems: string[] = [];
    const before: string[] = [];
    let current: string[] | undefined;
    for (const line of body) {
        const heading = /^##[ \t]+(.*?)[ \t]*$/.exec(line);
        if (heading !== null) {
            const name = heading[1] ?? "";
            if (!(SECTIONS as readonly string[]).includes(name)) {
                problems.push(`The section "${name}" is not one of ${SECTIONS.join(", ")}: remove it or rename it.`);
                current = [];
            } else if (found.has(name)) {
                problems.push(`The section ${name} appears twice: keep one.`);
                current = [];
            } else {
                current = [];
                found.set(name, current);
            }
            continue;
        }
        (current ?? before).push(line);
    }
    if (before.join("").trim() !== "") {
        problems.push("There is text before the first section: the body is only the three sections.");
    }
    const sections: Partial<CardSections> = {};
    for (const name of SECTIONS) {
        const lines = found.get(name);
        if (lines === undefined) {
            problems.push(`The section ${name} is missing: add "## ${name}" and its text.`);
            continue;
        }
        const value = lines.join("\n").trim();
        sections[name] = value;
        if (value === "") problems.push(`The section ${name} is empty: write it from the notes.`);
        else if (value.includes(PLACEHOLDER))
            problems.push(`The section ${name} still says ${PLACEHOLDER}: replace it.`);
        else if (characters(value) > SECTION_LIMIT) {
            problems.push(
                `The section ${name} has ${characters(value)} characters, and the limit is ${SECTION_LIMIT}: shorten it.`,
            );
        }
    }
    return { front: parsed?.front, sections, problems };
}

/** Whether the front matter names the ticket the card is in the folder of. */
export function isValid(checked: CheckedCard, key: string): boolean {
    return checked.problems.length === 0 && checked.front?.ticket === key;
}
