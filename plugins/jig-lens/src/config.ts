// The `lens` section of jig.json: the viewers' port. jig-core checks the section with validateLens when it loads, so
// the rest of the plugin reads a section that is valid, or absent.

export interface LensSettings {
    /** The port of Grafana or Datasette on 127.0.0.1. */
    port: number;
}

export const DEFAULT_SETTINGS: LensSettings = { port: 3300 };

const FIELDS: ReadonlySet<string> = new Set(["port"]);

/** Fields that were settings once, with what took their place. */
const REMOVED: Readonly<Record<string, string>> = {
    viewer: "/lens grafana and /lens datasette choose the viewer",
};

function validPort(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * The errors in a raw `lens` section, each naming its key. An empty list means the section is valid. A misspelt field
 * is an error and not a silent default: `prot` would otherwise leave the port on its default without a word. A field
 * that was removed says what replaced it, so a jig.json from before is easy to mend.
 */
export function validateLens(raw: unknown): string[] {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["lens: must be an object"];
    const fields = raw as Record<string, unknown>;
    const errors = Object.keys(fields)
        .filter((name) => !FIELDS.has(name))
        .map((name) => {
            const instead = REMOVED[name];
            if (instead === undefined) return `lens.${name}: unknown field`;
            return `lens.${name}: removed, because ${instead}; delete it`;
        });
    if (fields.port !== undefined && !validPort(fields.port)) {
        errors.push("lens.port: must be a whole number from 1 to 65535");
    }
    return errors;
}

/** The settings for the section as `config.section("lens")` returns it. A missing or wrong field is the default. */
export function settingsFrom(raw: unknown): LensSettings {
    const fields = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return { port: validPort(fields.port) ? fields.port : DEFAULT_SETTINGS.port };
}
