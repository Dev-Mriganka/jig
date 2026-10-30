// Pi draws assistant answers with no text colour (the terminal's default), so the theme's `text` colour never reaches
// them and answers blur into thinking text. This gives answer paragraphs a colour of the theme.
// It wraps one Pi internal, AssistantMessageComponent.updateContent, and does nothing if that shape changes.
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

export type Paint = (text: string) => string;

const PATCHED = Symbol.for("jig-theme.answer-text.patched");
const PAINTER = Symbol.for("jig-theme.answer-text.painter");
type Registry = { [PAINTER]?: () => Paint | undefined };

/** Colours the answer blocks of one assistant message: Markdown children Pi left without a text style. */
export function colourAnswers(component: unknown, paint: Paint | undefined): number {
    if (!paint) return 0;
    const children = (component as { contentContainer?: { children?: unknown } } | undefined)?.contentContainer?.children;
    if (!Array.isArray(children)) return 0;
    let coloured = 0;
    for (const child of children) {
        // Thinking blocks carry their own style (and sit inside a MouseRegion); only unstyled answers change.
        // By class or name: Pi's module loader may give the extension its own copy of pi-tui.
        if (!(child instanceof Markdown) && (child as { constructor?: { name?: string } } | undefined)?.constructor?.name !== "Markdown") continue;
        const block = child as unknown as { defaultTextStyle?: unknown }; // private in pi-tui's types
        if (block.defaultTextStyle === undefined) {
            block.defaultTextStyle = { color: paint };
            (child as { invalidate?: () => void }).invalidate?.();
            coloured++;
        }
    }
    return coloured;
}

/**
 * Starts colouring answers with `painter()` (read on every update, so a theme switch applies). Patches Pi once per
 * process; later calls only replace the painter. Returns false when Pi's shape is not the expected one.
 */
export function installAnswerText(painter: () => Paint | undefined): boolean {
    const proto = (AssistantMessageComponent as unknown as { prototype?: Record<PropertyKey, unknown> } | undefined)?.prototype;
    if (!proto || typeof proto.updateContent !== "function") return false;
    (globalThis as Registry)[PAINTER] = painter;
    if (!proto[PATCHED]) {
        const original = proto.updateContent as (...args: unknown[]) => unknown;
        proto.updateContent = function (this: unknown, ...args: unknown[]) {
            const result = original.apply(this, args);
            try {
                colourAnswers(this, (globalThis as Registry)[PAINTER]?.());
            } catch {
                // Never break message rendering.
            }
            return result;
        };
        proto[PATCHED] = true;
    }
    return true;
}

/** Stops colouring (the patch stays; with no painter it changes nothing). */
export function uninstallAnswerText(): void {
    delete (globalThis as Registry)[PAINTER];
}
