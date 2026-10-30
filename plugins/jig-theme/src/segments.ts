// Footer parts that other plugins add. A plugin emits on Pi's event bus and needs nothing from this one:
//
//     pi.events.emit("jig-theme:segment", { id: "spend", label: "Oct $120 / $200", tone: "warning" });
//
// An empty or missing `label` removes the part. What arrives is data from other code, so it is checked, cleaned of
// anything that is not text, cut to 40 cells, and limited to twelve parts.
import type { ForegroundRole } from "./roles.ts";
import { clean, fit } from "./width.ts";

export const SEGMENT_EVENT = "jig-theme:segment";
export const TONES = ["normal", "muted", "accent", "success", "warning", "error"] as const;
export type Tone = (typeof TONES)[number];
export const MAX_PLUGIN_SEGMENTS = 12;
export const MAX_LABEL_CELLS = 40;

export interface PluginSegment {
    id: string;
    label: string;
    tone: Tone;
    order: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;
const isTone = (value: unknown): value is Tone =>
    typeof value === "string" && (TONES as readonly string[]).includes(value);

/** The Pi text role each tone is drawn in. `normal` is the colour the footer configures for plugin parts. */
export function toneRole(tone: Tone, normal: ForegroundRole): ForegroundRole {
    switch (tone) {
        case "muted":
            return "muted";
        case "accent":
            return "accent";
        case "success":
            return "success";
        case "warning":
            return "warning";
        case "error":
            return "error";
        default:
            return normal;
    }
}

/** The parts plugins have set, by id. */
export class PluginSegments {
    private readonly items = new Map<string, PluginSegment>();

    /** Takes one event payload. Returns whether the parts changed, so the footer is redrawn only then. */
    accept(payload: unknown): boolean {
        if (typeof payload !== "object" || payload === null) return false;
        const { id, label, tone, order } = payload as Record<string, unknown>;
        if (typeof id !== "string" || !ID.test(id)) return false;
        if (label !== undefined && label !== null && typeof label !== "string") return false;
        const text = typeof label === "string" ? fit(clean(label, 200), MAX_LABEL_CELLS) : "";
        if (text === "") return this.items.delete(id);
        const existing = this.items.get(id);
        if (existing === undefined && this.items.size >= MAX_PLUGIN_SEGMENTS) return false;
        const next: PluginSegment = {
            id,
            label: text,
            tone: isTone(tone) ? tone : "normal",
            order: typeof order === "number" && Number.isFinite(order) ? order : 0,
        };
        if (
            existing !== undefined &&
            existing.label === next.label &&
            existing.tone === next.tone &&
            existing.order === next.order
        )
            return false;
        this.items.set(id, next);
        return true;
    }

    /** The parts in the order they are shown: by `order`, then by `id`. */
    list(): PluginSegment[] {
        return [...this.items.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    clear(): void {
        this.items.clear();
    }
}
