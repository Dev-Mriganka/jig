// What a session holds: the footer, whether it was switched off for this session, and the parts plugins have added.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSubagentChild } from "./child.ts";
import type { ThemeSettings } from "./config.ts";
import { DEFAULT_SETTINGS } from "./config.ts";
import { installFooter } from "./footer.ts";
import type { FooterHandle } from "./footer.ts";
import { PluginSegments } from "./segments.ts";
import { rewriteOwned } from "./write.ts";

export class Session {
    readonly plugins = new PluginSegments();
    private footer: FooterHandle | undefined;
    private switchedOff = false;
    private settings: ThemeSettings = DEFAULT_SETTINGS;
    /** Palettes whose file changed this session, and that Pi may still know by their old colours. */
    private readonly stale = new Set<string>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly pi: ExtensionAPI;
    private readonly env: NodeJS.ProcessEnv;

    constructor(pi: ExtensionAPI, env: NodeJS.ProcessEnv) {
        this.pi = pi;
        this.env = env;
    }

    /** Why the footer cannot be shown here, or undefined when it can. */
    blocked(ctx: ExtensionContext): string | undefined {
        if (ctx.mode !== "tui") return "it needs the terminal";
        if (isSubagentChild(this.env)) return "this Pi was started by another session, so it has no footer";
        if ((this.env.JIG_THEME_FOOTER?.trim() ?? "") === "0") return "JIG_THEME_FOOTER=0 turns it off";
        return undefined;
    }

    /** A session has started: the footer is shown, unless the settings, the environment or the kind of run say no. */
    start(ctx: ExtensionContext, settings: ThemeSettings): void {
        this.settings = settings;
        this.switchedOff = false;
        this.stop();
        this.clearTimers();
        if (settings.footer.enabled && this.blocked(ctx) === undefined) this.show(ctx);
    }

    /** `/theme footer on`: shown for this session, even when the settings turn it off. Returns why not, if it cannot be. */
    on(ctx: ExtensionContext): string | undefined {
        const why = this.blocked(ctx);
        if (why !== undefined) return why;
        this.switchedOff = false;
        this.stop();
        this.show(ctx);
        return undefined;
    }

    /** `/theme footer off`: Pi's own footer comes back for this session. */
    off(ctx: ExtensionContext): void {
        this.switchedOff = true;
        this.stop();
        if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
    }

    get isOff(): boolean {
        return this.switchedOff;
    }

    get shown(): boolean {
        return this.footer !== undefined;
    }

    refresh(): void {
        this.footer?.refresh();
    }

    /** These palettes were rewritten with new colours, and Pi has not read them since. */
    markStale(names: readonly string[]): void {
        this.stale.clear();
        for (const name of names) this.stale.add(name);
    }

    /**
     * Has Pi read a palette anew, if it changed this session: its file is written again as it is, after `delayMs` so that
     * Pi, which watches the theme in use, has started watching. Done once per change, and never for a file that is not ours.
     */
    reread(agentDir: string, name: string, delayMs: number): void {
        if (this.stale.delete(name)) this.later(() => rewriteOwned(agentDir, name), delayMs);
    }

    /** Runs `action` after a delay, unless the session ends first. */
    later(action: () => void, delayMs: number): void {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            action();
        }, delayMs);
        timer.unref();
        this.timers.add(timer);
    }

    shutdown(): void {
        this.stop();
        this.clearTimers();
        this.plugins.clear();
    }

    private clearTimers(): void {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }

    private show(ctx: ExtensionContext): void {
        this.footer = installFooter(this.pi, ctx, {
            settings: () => this.settings.footer,
            plugins: () => this.plugins.list(),
            env: this.env,
        });
    }

    private stop(): void {
        this.footer?.dispose();
        this.footer = undefined;
    }
}
