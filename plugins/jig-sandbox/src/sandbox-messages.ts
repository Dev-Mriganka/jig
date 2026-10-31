// The words the sandbox says when it refuses or fails: the refusal the agent reads, the message of an error, the first line of a
// command's output, and the hint for a kernel that will not make a user namespace. They are plain functions of text.
export function refusal(reason: string): string {
    return `bash is refused: ${reason}. Tell the user: /sandbox doctor checks each requirement, and /sandbox off runs commands without the sandbox for this session.`;
}

export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function firstLine(text: string): string {
    return (
        text
            .trim()
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim()
            .slice(0, 300) ?? ""
    );
}

/** What to try when bubblewrap cannot make a user namespace, as Ubuntu 24.04 does by default. */
export function userNamespaceHint(output: string): string {
    return /namespace|setting up uid map|operation not permitted|permission denied/i.test(output)
        ? ". Unprivileged user namespaces may be off: on Ubuntu 24.04, sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
        : "";
}
