// Small stand-ins for Pi's terminal interface and for the masker, so tests need neither a terminal nor the real masker.
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Masker } from "../../src/mask/index.ts";

/** What a fake screen was asked, and how many questions were open at once. */
export interface FakeUiLog {
    selects: Array<{ title: string; options: string[] }>;
    inputs: Array<{ title: string }>;
    customs: number;
    notifications: Array<{ message: string; type: string | undefined }>;
    active: number;
    maxActive: number;
}

export interface FakeUiScript {
    /** Answers a selector: the option to choose, or undefined to close it without an answer. */
    select?: (title: string, options: string[]) => string | undefined | Promise<string | undefined>;
    input?: (title: string) => string | undefined | Promise<string | undefined>;
    /** Runs the component factory the way Pi does: it gets a fake terminal, a theme, keybindings and `done`. */
    custom?: (
        factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown,
    ) => Promise<unknown>;
}

export function fakeUi(script: FakeUiScript = {}): { ui: ExtensionUIContext; log: FakeUiLog } {
    const log: FakeUiLog = { selects: [], inputs: [], customs: 0, notifications: [], active: 0, maxActive: 0 };
    // Counts questions open at the same moment, to prove they are asked one at a time.
    async function counted<T>(work: () => Promise<T>): Promise<T> {
        log.active++;
        log.maxActive = Math.max(log.maxActive, log.active);
        try {
            return await work();
        } finally {
            log.active--;
        }
    }
    const ui = {
        select: (title: string, options: string[]) =>
            counted(async () => {
                log.selects.push({ title, options });
                await Promise.resolve();
                return script.select?.(title, options);
            }),
        input: (title: string) =>
            counted(async () => {
                log.inputs.push({ title });
                return script.input?.(title);
            }),
        confirm: async () => false,
        notify: (message: string, type?: string) => {
            log.notifications.push({ message, type });
        },
        custom: (factory: Parameters<NonNullable<FakeUiScript["custom"]>>[0]) =>
            counted(async () => {
                log.customs++;
                if (script.custom === undefined) throw new Error("this fake screen has no custom component");
                return script.custom(factory);
            }),
    };
    return { ui: ui as unknown as ExtensionUIContext, log };
}

/** A fake terminal, theme and keybindings, for a component made by `ui.custom`. Styles are left off, so text is plain. */
export function fakeTerminal(rows = 24): {
    tui: unknown;
    theme: unknown;
    keybindings: unknown;
    rendered: { count: number };
} {
    const rendered = { count: 0 };
    return {
        tui: {
            terminal: { rows },
            requestRender: () => {
                rendered.count++;
            },
        },
        theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        keybindings: {},
        rendered,
    };
}

/** Replaces the word PERSONAL with [masked], in text and in every string of a structure. Enough to tell whether the
 *  backstop ran. */
export const fakeMasker: Masker = {
    text: (input) => input.replaceAll("PERSONAL", "[masked]"),
    value: <T>(input: T): T =>
        JSON.parse(JSON.stringify(input), (_key, value: unknown) =>
            typeof value === "string" ? value.replaceAll("PERSONAL", "[masked]") : value,
        ) as T,
};

/** A masker that cannot mask, like the stub before the real one is built. */
export const brokenMasker: Masker = {
    text: () => {
        throw new Error("masking is broken");
    },
    value: () => {
        throw new Error("masking is broken");
    },
};
