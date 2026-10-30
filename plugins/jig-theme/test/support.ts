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

export class FakePi {
    readonly handlers = new Map<string, Handler[]>();
    readonly listeners = new Map<string, Array<(payload: unknown) => void>>();
    readonly notices: Notice[] = [];
    readonly ctx: ExtensionContext;
    readonly options: Required<Pick<FakePiOptions, "mode" | "agentDir">> & FakePiOptions;
    current: FakeTheme;

    constructor(options: FakePiOptions) {
        this.options = { mode: "tui", ...options };
        this.current = fakeTheme(options.current ?? "dark");
        const self = this;
        this.ctx = {
            mode: this.options.mode,
            hasUI: this.options.mode === "tui" || this.options.mode === "rpc",
            cwd: "/work/orders-api",
            ui: {
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
