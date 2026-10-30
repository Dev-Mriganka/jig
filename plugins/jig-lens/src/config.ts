// The `lens` section of jig.json: which viewer to use, and its port. jig-core checks the section with validateLens when
// it loads, so the rest of the plugin reads a section that is valid, or absent.

export type Viewer = "grafana" | "datasette";

export interface LensSettings {
    viewer: Viewer;
    /** The viewer's port on 127.0.0.1. */
    port: number;
}

export const DEFAULT_SETTINGS: LensSettings = { viewer: "grafana", port: 3300 };

const VIEWERS: readonly string[] = ["grafana", "datasette"];
const FIELDS: ReadonlySet<string> = new Set(["viewer", "port"]);

function validPort(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * The errors in a raw `lens` section, each naming its key. An empty list means the section is valid. A misspelt field
 * is an error and not a silent default: `viewr` would otherwise leave the viewer on its default without a word.
 */
export function validateLens(raw: unknown): string[] {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["lens: must be an object"];
    const fields = raw as Record<string, unknown>;
    const errors = Object.keys(fields)
        .filter((name) => !FIELDS.has(name))
        .map((name) => `lens.${name}: unknown field`);
    if (fields.viewer !== undefined && !VIEWERS.includes(fields.viewer as string)) {
        errors.push(`lens.viewer: must be "grafana" or "datasette"`);
    }
    if (fields.port !== undefined && !validPort(fields.port)) {
        errors.push("lens.port: must be a whole number from 1 to 65535");
    }
    return errors;
}

/** The settings for the section as `config.section("lens")` returns it. A missing or wrong field is the default. */
export function settingsFrom(raw: unknown): LensSettings {
    const fields = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
        viewer: fields.viewer === "datasette" || fields.viewer === "grafana" ? fields.viewer : DEFAULT_SETTINGS.viewer,
        port: validPort(fields.port) ? fields.port : DEFAULT_SETTINGS.port,
    };
}
