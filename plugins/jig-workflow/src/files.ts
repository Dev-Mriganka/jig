// Small file helpers shared by the store and the ticket: replacing a file without ever leaving half of one.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** Replaces a file through a temporary file beside it, so a crash leaves the old text or the new, never a cut one. */
export function replaceFile(file: string, content: string, mode = 0o600): void {
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        writeFileSync(temp, content, { flag: "wx", mode });
        renameSync(temp, file);
    } catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
}

/** A text file's contents, or "" when it does not exist. */
export function readText(file: string): string {
    try {
        return readFileSync(file, "utf8");
    } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") return "";
        throw error;
    }
}
