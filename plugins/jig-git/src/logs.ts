// Job logs from GitHub Actions: fetched, cleaned, cut down to what a person would look at, and scrubbed of anything that
// looks like a credential. GitHub already masks the secrets a repository registered; the scrub here is a second net for
// the tokens a failing step printed by accident.
import { gh, ghFailure } from "./github.ts";
import type { GhOptions } from "./github.ts";
import { firstLines, lastLines } from "./text.ts";

const LOG_BYTES = 8 * 1024 * 1024;

/** The log of one job, as text. A job is a check run of GitHub Actions; its id is the check run's id. */
export async function jobLog(slug: string, jobId: number, options: GhOptions = {}): Promise<string> {
    const result = await gh(["api", `repos/${slug}/actions/jobs/${jobId}/logs`], { ...options, maxBytes: LOG_BYTES });
    if (result.code !== 0 || result.timedOut) {
        if (/HTTP 410|HTTP 404/.test(result.stderr))
            throw new Error(
                `the log of job ${jobId} is not available (it expired, or the job is not a GitHub Actions job)`,
            );
        throw ghFailure(`gh api job ${jobId} logs`, result);
    }
    return result.stdout;
}

const STAMP = /^(?:﻿)?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** One log line per line: no carriage returns, no colour codes, no time stamp in front. */
export function cleanLog(raw: string): string {
    return raw
        .replace(/\r/g, "")
        .replace(ANSI, "")
        .split("\n")
        .map((line) => line.replace(STAMP, ""))
        .join("\n");
}

const SECRETS: Array<[RegExp, string]> = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[redacted]"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]"],
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted token]"],
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
    [
        /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)(?!\*\*\*)[^\s'"]{6,}/gi,
        "$1$2[redacted]",
    ],
];

/** Replaces what looks like a credential. A second net: jig-core also removes every secret value it knows. */
export function redactLog(text: string): string {
    return SECRETS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

const ERROR_LINE = /##\[error\]|^Error:|\bFAILED\b|\bfatal:|Traceback \(most recent call last\)/;

/**
 * The part of a failed log worth reading first: the lines leading up to the first error and the error itself, or the end
 * of the log when nothing says "error". Cut to `maxLines` lines and `maxChars` characters.
 */
export function failureExcerpt(log: string, maxLines = 20, maxChars = 2000): string {
    const lines = cleanLog(log).replace(/\n$/, "").split("\n");
    const at = lines.findIndex((line) => ERROR_LINE.test(line));
    const picked = at < 0 ? lines.slice(-maxLines) : lines.slice(Math.max(0, at - (maxLines - 3)), at + 3);
    const text = redactLog(picked.join("\n"));
    return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

const LOG_LINES = 400;

/** The end of a log, or the lines that match a search, cut to `LOG_LINES` lines. */
export function selectLog(log: string, options: { tail?: number; grep?: string }): { text: string; note: string } {
    const cleaned = redactLog(cleanLog(log));
    if (options.grep !== undefined) {
        const pattern = new RegExp(options.grep, "i");
        const matches = cleaned
            .split("\n")
            .flatMap((line, index) => (pattern.test(line) ? [`${index + 1}: ${line}`] : []));
        if (matches.length === 0) return { text: "", note: `no line matches ${options.grep}` };
        const shown = firstLines(matches.join("\n"), LOG_LINES);
        return {
            text: shown.text,
            note: `${matches.length} matching lines${shown.cut > 0 ? `, the first ${LOG_LINES} shown` : ""}`,
        };
    }
    const want = Math.max(1, Math.min(LOG_LINES, Math.trunc(options.tail ?? 80)));
    const shown = lastLines(cleaned, want);
    return {
        text: shown.text,
        note: shown.cut > 0 ? `the last ${want} lines; ${shown.cut} earlier lines left out` : "the whole log",
    };
}
