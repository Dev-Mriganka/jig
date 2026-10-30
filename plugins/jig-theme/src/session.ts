// What a session holds: the footer, whether it was switched off for this session, and the parts plugins have added.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSubagentChild } from "./child.ts";
import type { ThemeSettings } from "./config.ts";
import { DEFAULT_SETTINGS } from "./config.ts";
import { installFooter } from "./footer.ts";
import type { FooterHandle } from "./footer.ts";
import { PluginSegments } from "./segments.ts";

export class Session {
    readonly plugins = new PluginSegments();
    private footer: FooterHandle | undefined;
    private switchedOff = false;
    private settings: ThemeSettings = DEFAULT_SETTINGS;
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

    shutdown(): void {
        this.stop();
        this.plugins.clear();
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
