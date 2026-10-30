// Names for the models in the usage view. A provider may record a model under an id that means nothing to read, so another
// plugin can say what to show, on Pi's event bus. This plugin knows nothing of who sends it, and shows what was recorded when
// nobody does:
//
//     pi.events.emit("jig-lens:model-names", { models: [{ recorded: "m-2f9c", name: "Claude Sonnet", provider: "anthropic" }] });
import type { ModelNames } from "./usage-history.ts";

export const MODEL_NAMES_EVENT = "jig-lens:model-names";
/** The most names that are kept; an event past that cannot add more, though it can rename one that is known. */
export const MAX_MODEL_NAMES = 4096;

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null;

/** One line of text: control characters and the ones that reorder text are removed, and runs of white space become one space. */
const oneLine = (value: string): string => value.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();

interface Shown {
    name: string;
    provider?: string;
}

export interface ModelNameBook {
    /** Takes one event payload: `{ models: [{ recorded, name, provider? }] }`. Anything malformed is skipped. */
    learn(payload: unknown): void;
    /** For `summarizeHistory`: the name and provider to show for what was recorded, or undefined to show it as recorded. */
    names: ModelNames;
    readonly size: number;
}

export function createModelNames(): ModelNameBook {
    const known = new Map<string, Shown>();
    return {
        learn(payload) {
            const models = isRec(payload) ? payload.models : undefined;
            if (!Array.isArray(models)) return;
            for (const item of models.slice(0, MAX_MODEL_NAMES)) {
                if (!isRec(item) || typeof item.recorded !== "string" || typeof item.name !== "string") continue;
                const recorded = item.recorded;
                const name = oneLine(item.name).slice(0, 80);
                if (recorded === "" || recorded.length > 512 || name === "") continue;
                const provider = typeof item.provider === "string" ? oneLine(item.provider).slice(0, 60) : "";
                if (!known.has(recorded) && known.size >= MAX_MODEL_NAMES) continue;
                known.set(recorded, provider === "" ? { name } : { name, provider });
            }
        },
        names: (provider, model) => {
            const shown = known.get(model);
            return shown === undefined ? undefined : { provider: shown.provider ?? provider, model: shown.name };
        },
        get size() {
            return known.size;
        },
    };
}
