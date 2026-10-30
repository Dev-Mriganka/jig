// Test support: a fake Pi (the calls the plugin makes, and nothing of Pi's SDK), a temporary agent folder, and a fake
// jig-core that holds the `theme` section.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { publishJig, withdrawJig } from "../../jig-core/src/client.ts";
import type { JigApi } from "../../jig-core/src/contract.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { theme } from "../src/index.ts";
import { PALETTE_NAMES } from "../src/palettes.ts";
import type { ThemeOptions } from "../src/index.ts";
import { settingsFrom } from "../src/config.ts";

export interface Notice {
    text: string;
    level: string;
}

/** A temporary agent folder, removed when the test ends. */
export function tempAgentDir(t: TestContext): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jig-theme-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

/** Pi's theme, as far as the plugin looks at it: a name, and colours painted as `<role>text</>`, or with real escapes so a width is measured as Pi measures it. */
export class FakeTheme {
    readonly name: string;
    readonly appearance: string;
    private readonly ansi: boolean;

    constructor(name: string, appearance = "dark", ansi = false) {
        this.name = name;
        this.appearance = appearance;
        this.ansi = ansi;
    }

    fg(role: string, text: string): string {
        return this.ansi ? `\u001b[38;5;${this.name.length + 30}m${text}\u001b[39m` : `<${role}>${text}</>`;
    }

    bold(text: string): string {
        return this.ansi ? `\u001b[1m${text}\u001b[22m` : `<b>${text}</b>`;
    }
}

export const fakeTheme = (name: string, appearance = "dark", ansi = false): FakeTheme =>
    new FakeTheme(name, appearance, ansi);

export interface FakePiOptions {
    mode?: "tui" | "rpc" | "json" | "print";
    /** Pi's agent folder: the fake finds themes written there, as Pi does. */
    agentDir: string;
    /** The theme in use when the session starts. */
    current?: string;
    /** Names of themes Pi ships. */
    builtins?: string[];
    /** Another theme's name and file, such as one a project brings. */
    others?: Array<{ name: string; path: string }>;
    /** The themes this package ships. Default: the six palettes. */
    shipped?: string[];
    /** Paint with real escape sequences instead of readable tags. */
    ansi?: boolean;
}

/** What a footer is, as the fake keeps it: the component Pi would draw, or undefined for Pi's own footer. */
export type FooterComponent = { render(width: number): string[]; dispose?(): void; invalidate?(): void };

export class FakePi {
    readonly handlers = new Map<string, Handler[]>();
    readonly listeners = new Map<string, Array<(payload: unknown) => void>>();
    readonly notices: Notice[] = [];
    readonly ctx: ExtensionContext;
    readonly options: Required<Pick<FakePiOptions, "mode" | "agentDir">> & FakePiOptions;
    current: FakeTheme;
    /** Every call to `setFooter`, in order: the component made, or undefined when Pi's footer was asked for back. */
    readonly footers: Array<FooterComponent | undefined> = [];
    /** How often the footer asked to be drawn again. */
    renders = 0;
    disposed = 0;
    // What the footer reads.
    model:
        | { name?: string; id?: string; contextWindow?: number; promptCache?: { short?: number; long?: number } }
        | undefined = {
        name: "Fixture Model",
        id: "fixture-model",
        contextWindow: 1_000_000,
    };
    thinking = "high";
    statuses = new Map<string, string>();
    branch: string | null = "main";
    entries: unknown[] = [];
    context: { tokens: number | null; contextWindow: number; percent: number | null } | undefined = {
        tokens: 42_000,
        contextWindow: 1_000_000,
        percent: 4.2,
    };
    branchListeners = new Set<() => void>();
    readonly commands = new Map<
        string,
        {
            description?: string;
            handler: (args: string, ctx: ExtensionCommandContext) => unknown;
            getArgumentCompletions?: (prefix: string) => unknown;
        }
    >();
    /** Every call to `ui.setTheme`: a name, or the theme object a preview passes. */
    readonly setThemeCalls: Array<string | FakeTheme> = [];
    /** What `ui.custom` was given, with the promise it returned and the value it finished with. */
    readonly customs: Array<{
        component: { render(width: number): string[]; handleInput?(data: string): void };
        result: Promise<unknown>;
    }> = [];
    reloads = 0;
    reloadFails = false;
    /** Rows of the terminal, which the picker sizes its list by. */
    rows = 30;

    constructor(options: FakePiOptions) {
        this.options = { mode: "tui", ...options };
        this.current = fakeTheme(options.current ?? "dark", "dark", options.ansi === true);
        const self = this;
        this.ctx = {
            mode: this.options.mode,
            hasUI: this.options.mode === "tui" || this.options.mode === "rpc",
            cwd: "/work/orders-api",
            reload: async () => {
                self.reloads++;
                if (self.reloadFails) throw new Error("no");
            },
            get model() {
                return self.model;
            },
            getContextUsage: () => self.context,
            sessionManager: { getEntries: () => self.entries, getBranch: () => self.entries },
            ui: {
                setFooter: (factory?: (tui: unknown, theme: unknown, data: unknown) => FooterComponent) => {
                    // Pi disposes the footer it replaces or takes away.
                    self.footers.at(-1)?.dispose?.();
                    if (factory === undefined) {
                        self.footers.push(undefined);
                        return;
                    }
                    const component = factory({ requestRender: () => self.renders++ }, self.ctx.ui.theme, {
                        getExtensionStatuses: () => self.statuses,
                        getGitBranch: () => self.branch,
                        onBranchChange: (listener: () => void) => {
                            self.branchListeners.add(listener);
                            return () => self.branchListeners.delete(listener);
                        },
                    });
                    const dispose = component.dispose?.bind(component);
                    component.dispose = () => {
                        self.disposed++;
                        dispose?.();
                    };
                    self.footers.push(component);
                },
                notify: (text: string, level?: string) => {
                    this.notices.push({ text, level: level ?? "info" });
                },
                // Pi's `ui.theme` is a view of whichever theme is in use now, not the theme object itself.
                theme: new Proxy(
                    {},
                    {
                        get: (_target, property) =>
                            (self.current as unknown as Record<string | symbol, unknown>)[property],
                    },
                ),
                getAllThemes: () => self.allThemes(),
                getTheme: (name: string) => self.loadTheme(name),
                setTheme: (themeOrName: string | FakeTheme) => {
                    self.setThemeCalls.push(themeOrName);
                    // Only a real theme object is switched to as it is; anything else is taken for a name, as Pi does.
                    if (themeOrName instanceof FakeTheme) {
                        self.current = themeOrName;
                        return { success: true };
                    }
                    const loaded = self.loadTheme(String(themeOrName));
                    if (loaded === undefined)
                        return { success: false, error: `Theme not found: ${String(themeOrName)}` };
                    self.current = loaded;
                    return { success: true };
                },
                custom: (
                    factory: (
                        tui: unknown,
                        theme: unknown,
                        keys: unknown,
                        done: (value: unknown) => void,
                    ) => { render(width: number): string[]; handleInput?(data: string): void },
                ) => {
                    let finish: (value: unknown) => void = () => {};
                    const result = new Promise<unknown>((resolve) => {
                        finish = resolve;
                    });
                    const component = factory(
                        { requestRender: () => self.renders++, terminal: { rows: self.rows } },
                        self.ctx.ui.theme,
                        {},
                        (value) => finish(value),
                    );
                    self.customs.push({ component, result });
                    return result;
                },
            },
        } as unknown as ExtensionContext;
    }

    get api(): ExtensionAPI {
        return this as unknown as ExtensionAPI;
    }

    getThinkingLevel(): string {
        return this.thinking;
    }

    /** The footer in use now, or undefined when Pi's own is. */
    get footer(): FooterComponent | undefined {
        return this.footers.at(-1);
    }

    /** The footer's one row at a width. */
    row(width = 300): string {
        const footer = this.footer;
        if (footer === undefined) throw new Error("no footer");
        return footer.render(width)[0] ?? "";
    }

    /** What Pi lists: its own themes, other packages', and the files in the agent folder. */
    allThemes(): Array<{ name: string; path: string | undefined }> {
        const themes: Array<{ name: string; path: string | undefined }> = [{ name: "system", path: undefined }];
        for (const name of this.options.builtins ?? ["dark", "light"])
            themes.push({ name, path: path.join("/pi/themes", `${name}.json`) });
        for (const name of this.options.shipped ?? PALETTE_NAMES)
            themes.push({ name, path: path.join("/pkg/themes", `${name}.json`) });
        for (const other of this.options.others ?? []) themes.push(other);
        const folder = path.join(this.options.agentDir, "themes");
        if (existsSync(folder)) {
            for (const name of this.fileNames(folder)) themes.push({ name, path: path.join(folder, `${name}.json`) });
        }
        return themes;
    }

    private fileNames(folder: string): string[] {
        const names: string[] = [];
        for (const entry of readdirSafe(folder)) {
            if (!entry.endsWith(".json")) continue;
            try {
                const json = JSON.parse(readFileSync(path.join(folder, entry), "utf8")) as { name?: unknown };
                if (typeof json.name === "string") names.push(json.name);
            } catch {
                // Pi ignores a file it cannot read here, too.
            }
        }
        return names;
    }

    /** A theme by name, or undefined when Pi cannot load it: the file is missing, is not JSON, or has no colours. */
    loadTheme(name: string): FakeTheme | undefined {
        const ansi = this.options.ansi === true;
        if (name === "system" || (this.options.builtins ?? ["dark", "light"]).includes(name))
            return fakeTheme(name, "dark", ansi);
        if ((this.options.shipped ?? PALETTE_NAMES).includes(name))
            return fakeTheme(name, name === "jig-paper" ? "light" : "dark", ansi);
        const file = path.join(this.options.agentDir, "themes", `${name}.json`);
        try {
            const json = JSON.parse(readFileSync(file, "utf8")) as {
                name?: string;
                appearance?: string;
                colors?: unknown;
            };
            return typeof json.colors === "object" && json.colors !== null
                ? fakeTheme(json.name ?? name, json.appearance ?? "dark", ansi)
                : undefined;
        } catch {
            return undefined;
        }
    }

    get events() {
        return {
            on: (name: string, listener: (payload: unknown) => void) => {
                this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
                return () => {
                    this.listeners.set(
                        name,
                        (this.listeners.get(name) ?? []).filter((item) => item !== listener),
                    );
                };
            },
            emit: (name: string, payload: unknown) => {
                for (const listener of this.listeners.get(name) ?? []) listener(payload);
            },
        };
    }

    on(event: string, handler: Handler): void {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }

    registerCommand(
        name: string,
        options: {
            description?: string;
            handler: (args: string, ctx: ExtensionCommandContext) => unknown;
            getArgumentCompletions?: (prefix: string) => unknown;
        },
    ): void {
        this.commands.set(name, options);
    }

    /** Runs `/theme <args>` and returns the notices it showed. */
    async theme(args = ""): Promise<Notice[]> {
        const before = this.notices.length;
        const command = this.commands.get("theme");
        if (command === undefined) throw new Error("no command theme");
        await command.handler(args, this.ctx as unknown as ExtensionCommandContext);
        return this.notices.slice(before);
    }

    /** Runs the handlers of an event in order, and waits for each. */
    async fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
        for (const handler of this.handlers.get(event) ?? []) await handler({ type: event, ...payload }, this.ctx);
    }

    /** Everything the plugin said as a notification, in order. */
    texts(level?: string): string[] {
        return this.notices
            .filter((notice) => level === undefined || notice.level === level)
            .map((notice) => notice.text);
    }
}

function readdirSafe(folder: string): string[] {
    try {
        return readdirSync(folder);
    } catch {
        return [];
    }
}

/** Waits for what the plugin delays. */
export const settle = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The plugin loaded into a fake Pi, with the settings a test gives it. */
export function rig(
    t: TestContext,
    o: { settings?: unknown; env?: NodeJS.ProcessEnv; viaJig?: boolean } & Partial<FakePiOptions> = {},
) {
    const agentDir = o.agentDir ?? tempAgentDir(t);
    mkdirSync(agentDir, { recursive: true });
    const { settings, env, viaJig, ...piOptions } = o;
    const pi = new FakePi({ ...piOptions, agentDir });
    // `viaJig` leaves the settings to the plugin, which asks the fake jig-core for its section, as it does in Pi.
    // Short delays, so that what waits for Pi to finish a reload, or to start watching a file, is waited for in a test.
    const options: ThemeOptions = {
        env: env ?? {},
        agentDir: () => agentDir,
        noticeDelayMs: 5,
        rereadDelayMs: 5,
        ...(viaJig === true ? {} : { settings: () => settingsFrom(settings) }),
    };
    theme(options)(pi.api);
    return { pi, agentDir };
}

// ---- a fake jig-core ------------------------------------------------------------------------------------------------

export interface FakeJig {
    checks: Map<string, (raw: unknown) => readonly string[]>;
    reads: string[];
}

/** Publishes a fake jig-core for the rest of the test, as jig-core does at start-up. `sections` is jig.json's. */
export function useJig(t: TestContext, sections: Record<string, unknown> = {}): FakeJig {
    const fake: FakeJig = { checks: new Map(), reads: [] };
    const api = {
        version: 1,
        config: {
            registerSection: (name: string, check: (raw: unknown) => readonly string[]) => {
                fake.checks.set(name, check);
            },
            section: (name: string) => {
                fake.reads.push(name);
                return sections[name];
            },
        },
    } as unknown as JigApi;
    publishJig(api);
    t.after(() => withdrawJig(api));
    return fake;
}
