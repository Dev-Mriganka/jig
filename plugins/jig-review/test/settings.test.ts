import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS, parseReviewSettings, reviewRoot, SettingsStore, workspaceDirFor } from "../src/settings.ts";
import { formatSettingsOptions, passkeyToRemove, toggleSelectedSetting } from "../src/settings-options.ts";

let tempDirectory: string | undefined;

afterEach(async () => {
    if (tempDirectory !== undefined) {
        await rm(tempDirectory, { force: true, recursive: true });
        tempDirectory = undefined;
    }
});

async function createTempDirectory(): Promise<string> {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "jig-review-settings-"));
    return tempDirectory;
}

describe("SettingsStore", () => {
    it("loads defaults when config is absent", async () => {
        assert.deepEqual(await new SettingsStore(await createTempDirectory()).load(), DEFAULT_SETTINGS);
    });

    it("ignores unknown keys and values of the wrong type", () => {
        assert.deepEqual(
            parseReviewSettings({
                autoAskReview: true,
                autoOpenBrowser: "yes",
                commentMode: "interactive",
                diffView: "side-by-side",
            }),
            { ...DEFAULT_SETTINGS, autoAskReview: true },
        );
    });

    it("loads persisted valid settings", async () => {
        const store = new SettingsStore(await createTempDirectory());
        await store.ensureDirectories();
        await writeFile(
            path.join(store.reviewDir, "config.json"),
            JSON.stringify({ autoOpenBrowser: true, diffView: "unified" }),
            "utf8",
        );
        assert.deepEqual(await store.load(), { ...DEFAULT_SETTINGS, autoOpenBrowser: true, diffView: "unified" });
    });

    it("saves settings and the folders private: reviews hold the user's code", async () => {
        const store = new SettingsStore(path.join(await createTempDirectory(), "ws"));
        await store.save({ ...DEFAULT_SETTINGS, diffView: "unified" });
        assert.equal((await stat(path.join(store.reviewDir, "config.json"))).mode & 0o777, 0o600);
        assert.equal((await stat(store.reviewsDir)).mode & 0o077, 0, "no access for group or others");
        assert.equal((await store.load()).diffView, "unified");
    });
});

describe("where the records live", () => {
    it("is under the agent folder, one folder per workspace path", () => {
        const root = reviewRoot("/agent");
        assert.equal(root, "/agent/jig-review");
        const one = workspaceDirFor(root, "/work/orders");
        const two = workspaceDirFor(root, "/other/orders");
        assert.match(one, /^\/agent\/jig-review\/workspaces\/orders-[0-9a-f]{12}$/);
        assert.notEqual(one, two, "same name, different path");
    });
});

describe("the settings menu", () => {
    it("toggles a setting, and a passkey line changes none", () => {
        const settings = { ...DEFAULT_SETTINGS };
        toggleSelectedSetting(settings, "autoAskReview: false");
        toggleSelectedSetting(settings, "diffView: split");
        assert.deepEqual(settings, { ...DEFAULT_SETTINGS, autoAskReview: true, diffView: "unified" });
        toggleSelectedSetting(settings, "remove passkey 3f9a1c7eb2d04a55 (ES256)");
        assert.deepEqual(settings, { ...DEFAULT_SETTINGS, autoAskReview: true, diffView: "unified" });
    });

    it("offers to remove each registered passkey, and maps a chosen line back to it", () => {
        const keys = [
            {
                fingerprint: "3f9a1c7eb2d04a55".padEnd(64, "0"),
                algorithm: "ES256" as const,
                createdAt: "2026-01-01T00:00:00Z",
            },
            {
                fingerprint: "aa00bb11cc22dd33".padEnd(64, "1"),
                algorithm: "RS256" as const,
                createdAt: "2026-01-02T00:00:00Z",
            },
        ];
        const lines = formatSettingsOptions(DEFAULT_SETTINGS, keys);
        assert.equal(lines.length, 5);
        assert.equal(passkeyToRemove(lines[4]!, keys), keys[1]);
        assert.equal(passkeyToRemove(lines[0]!, keys), undefined);
        assert.equal(passkeyToRemove("remove passkey ffffffffffffffff (ES256)", keys), undefined, "no such key");
    });
});
