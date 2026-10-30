// Test support: a fake Pi (the calls the plugin makes, and nothing of Pi's SDK), a temporary agent folder, and a fake
// jig-core that holds the `theme` section.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { publishJig, withdrawJig } from "../../jig-core/src/client.ts";
import type { JigApi } from "../../jig-core/src/contract.ts";
import { theme } from "../src/index.ts";
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

/** Pi's theme, as far as the plugin looks at it: a name, and colours painted as `<role>text</>`. */
export interface FakeTheme {
    name: string;
    fg(role: string, text: string): string;
}

export const fakeTheme = (name: string): FakeTheme => ({ name, fg: (role, text) => `<${role}>${text}</>` });

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
    model: { name?: string; id?: string; contextWindow?: number; promptCache?: { short?: number; long?: number } } | undefined = {
        name: "Fixture Model",
        id: "fixture-model",
        contextWindow: 1_000_000,
    };
    thinking = "high";
    statuses = new Map<string, string>();
    branch: string | null = "main";
    entries: unknown[] = [];
    context: { tokens: number | null; contextWindow: number; percent: number | null } | undefined = { tokens: 42_000, contextWindow: 1_000_000, percent: 4.2 };
    branchListeners = new Set<() => void>();

    constructor(options: FakePiOptions) {
        this.options = { mode: "tui", ...options };
        this.current = fakeTheme(options.current ?? "dark");
        const self = this;
        this.ctx = {
            mode: this.options.mode,
            hasUI: this.options.mode === "tui" || this.options.mode === "rpc",
            cwd: "/work/orders-api",
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
                    const component = factory(
                        { requestRender: () => self.renders++ },
                        self.current,
                        {
                            getExtensionStatuses: () => self.statuses,
                            getGitBranch: () => self.branch,
                            onBranchChange: (listener: () => void) => {
                                self.branchListeners.add(listener);
                                return () => self.branchListeners.delete(listener);
                            },
                        },
                    );
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
                get theme() {
                    return self.current;
                },
                getAllThemes: () => self.allThemes(),
                getTheme: (name: string) => self.loadTheme(name),
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
        for (const name of this.options.builtins ?? ["dark", "light"]) themes.push({ name, path: path.join("/pi/themes", `${name}.json`) });
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
        if (name === "system" || (this.options.builtins ?? ["dark", "light"]).includes(name)) return fakeTheme(name);
        const file = path.join(this.options.agentDir, "themes", `${name}.json`);
        try {
            const json = JSON.parse(readFileSync(file, "utf8")) as { name?: string; colors?: unknown };
            return typeof json.colors === "object" && json.colors !== null ? fakeTheme(json.name ?? name) : undefined;
        } catch {
            return undefined;
        }
    }

    get events() {
        return {
            on: (name: string, listener: (payload: unknown) => void) => {
                this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
                return () => {
                    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
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

    /** Runs the handlers of an event in order, and waits for each. */
    async fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
        for (const handler of this.handlers.get(event) ?? []) await handler({ type: event, ...payload }, this.ctx);
    }

    /** Everything the plugin said as a notification, in order. */
    texts(level?: string): string[] {
        return this.notices.filter((notice) => level === undefined || notice.level === level).map((notice) => notice.text);
    }
}

function readdirSafe(folder: string): string[] {
    try {
        return readdirSync(folder);
    } catch {
        return [];
    }
}

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
    const options: ThemeOptions = { env: env ?? {}, agentDir: () => agentDir, ...(viaJig === true ? {} : { settings: () => settingsFrom(settings) }) };
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
