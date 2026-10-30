// What the extension needs to know about a unified diff without parsing it whole.

/** The paths a diff changes, in order, each once: the new path of every `diff --git` header. */
export function filesOfDiff(diff: string): string[] {
    const files: string[] = [];
    for (const line of diff.split("\n")) {
        const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        if (match?.[2] !== undefined && !files.includes(match[2])) files.push(match[2]);
    }
    return files;
}
