// The settings menu of `/code-review settings`: one line per setting, and choosing a line changes it.
import type { PasskeySummary, ReviewSettings } from "./types.ts";

/** Prefix of the menu lines that remove a passkey. */
export const REMOVE_PASSKEY = "remove passkey ";

/** The menu: each setting with its value, then a line to remove each registered passkey. */
export function formatSettingsOptions(settings: ReviewSettings, passkeys: readonly PasskeySummary[] = []): string[] {
    return [
        `autoAskReview: ${String(settings.autoAskReview)}`,
        `autoOpenBrowser: ${String(settings.autoOpenBrowser)}`,
        `diffView: ${settings.diffView}`,
        ...passkeys.map((key) => `${REMOVE_PASSKEY}${key.fingerprint.slice(0, 16)} (${key.algorithm})`),
    ];
}

/** Changes the setting a chosen menu line stands for. A line for a passkey changes no setting. */
export function toggleSelectedSetting(settings: ReviewSettings, choice: string): void {
    if (choice.startsWith("autoAskReview")) settings.autoAskReview = !settings.autoAskReview;
    else if (choice.startsWith("autoOpenBrowser")) settings.autoOpenBrowser = !settings.autoOpenBrowser;
    else if (choice.startsWith("diffView")) settings.diffView = settings.diffView === "split" ? "unified" : "split";
}

/** The passkey a chosen menu line removes, or undefined for any other line. */
export function passkeyToRemove(choice: string, passkeys: readonly PasskeySummary[]): PasskeySummary | undefined {
    if (!choice.startsWith(REMOVE_PASSKEY)) return undefined;
    const prefix = choice.slice(REMOVE_PASSKEY.length).split(" ")[0] ?? "";
    return prefix === "" ? undefined : passkeys.find((key) => key.fingerprint.startsWith(prefix));
}
