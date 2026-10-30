// Opens a review link with $BROWSER (set it to a Windows opener on WSL), else xdg-open. Best effort: Pi also prints the
// link, so a failed open never blocks the review.
import { spawn } from "node:child_process";

export function openUrl(url: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const opener = env.BROWSER || "xdg-open";
    try {
        spawn(opener, [url], { detached: true, stdio: "ignore", env })
            .on("error", () => {})
            .unref();
    } catch {
        // the printed link still works
    }
    return Promise.resolve();
}
