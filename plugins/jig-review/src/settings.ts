// Review settings, and where one workspace's records live. Everything is under `<agent folder>/jig-review/`: the agent's
// shell does not write Pi's agent folder, so a record that says "approved" there was written by this extension and not by
// a command the agent ran.
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewSettings } from "./types.ts";

const CONFIG_FILE = "config.json";

/** `<agent folder>/jig-review`: the passkey store, and one folder per workspace for settings and reviews. */
export function reviewRoot(agentDir: string): string {
    return path.join(agentDir, "jig-review");
}

/** One folder per workspace path: its name for a person to recognise, a hash of the whole path to tell two apart. */
export function workspaceDirFor(root: string, cwd: string): string {
    const name = `${path.basename(cwd) || "root"}-${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`;
    return path.join(root, "workspaces", name);
}

export const DEFAULT_SETTINGS: ReviewSettings = {
    autoAskReview: false,
    autoOpenBrowser: false,
    diffView: "split",
};

/** Review settings and records for one workspace. */
export class SettingsStore {
    private readonly dir: string;

    /** `dir` is the workspace's folder: it holds `config.json` and `reviews/`. */
    public constructor(dir: string) {
        this.dir = dir;
    }

    public get reviewDir(): string {
        return this.dir;
    }

    /** The folder holding one JSON file per review. */
    public get reviewsDir(): string {
        return path.join(this.reviewDir, "reviews");
    }

    /** The saved settings, or the defaults when none are saved or the file is not readable. */
    public async load(): Promise<ReviewSettings> {
        try {
            return parseReviewSettings(JSON.parse(await readFile(this.configPath, "utf8")));
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    public async save(settings: ReviewSettings): Promise<void> {
        await this.ensureDirectories();
        await writeFile(this.configPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(this.configPath, 0o600);
    }

    /** Creates the folders private: reviews hold the diffs of the user's code. */
    public async ensureDirectories(): Promise<void> {
        await mkdir(this.reviewsDir, { recursive: true, mode: 0o700 });
    }

    private get configPath(): string {
        return path.join(this.reviewDir, CONFIG_FILE);
    }
}

/** Settings from a parsed file: a key that is missing, of the wrong type or unknown is ignored. */
export function parseReviewSettings(value: unknown): ReviewSettings {
    if (typeof value !== "object" || value === null) return { ...DEFAULT_SETTINGS };
    const raw = value as Record<string, unknown>;
    return {
        autoAskReview: typeof raw.autoAskReview === "boolean" ? raw.autoAskReview : DEFAULT_SETTINGS.autoAskReview,
        autoOpenBrowser:
            typeof raw.autoOpenBrowser === "boolean" ? raw.autoOpenBrowser : DEFAULT_SETTINGS.autoOpenBrowser,
        diffView: raw.diffView === "split" || raw.diffView === "unified" ? raw.diffView : DEFAULT_SETTINGS.diffView,
    };
}
