// Reading YAML for the sources that need it (Bruno's OpenCollection files, OpenAPI specs). The `yaml` package parses; nothing
// in a file is ever run. A file that does not parse is a problem with its file and line, and the message never quotes the file:
// a line of a Bruno environment may hold a secret.
import { LineCounter, parseDocument } from "yaml";
import type { Problem } from "../model.ts";

/** Aliases a file may expand. An alias bomb (a few lines that expand to millions) is stopped at this. */
const MAX_ALIASES = 50;

/**
 * The value in YAML text, as plain JSON-like data, or undefined with the reason in `problems`. `file` names the file in them.
 * Duplicate keys are an error, since two values for one key mean one of them is silently lost.
 */
export function parseYaml(text: string, file: string, problems: Problem[]): unknown {
    const lines = new LineCounter();
    try {
        const document = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
        const error = document.errors[0];
        if (error !== undefined) {
            const line = lines.linePos(error.pos[0]).line;
            problems.push({ file, key: `line ${line}`, message: `is not valid YAML (${error.code})`, level: "error" });
            return undefined;
        }
        return document.toJS({ maxAliasCount: MAX_ALIASES });
    } catch {
        problems.push({
            file,
            key: "",
            message: "is not valid YAML (too many aliases, or a structure that is too deep)",
            level: "error",
        });
        return undefined;
    }
}
