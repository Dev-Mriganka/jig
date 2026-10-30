// Which changed files a review shows: not installed packages, and not what the repository's .gitignore ignores.
import ignore from "ignore";

export const DEFAULT_IGNORED_REVIEW_FILES = ["node_modules/**"];

/** `files` are paths relative to the repository, as git reports them. */
export function filterReviewableFiles(files: string[], gitignoreContent?: string): string[] {
    const matcher = ignore().add(DEFAULT_IGNORED_REVIEW_FILES);
    if (gitignoreContent !== undefined) matcher.add(gitignoreContent);
    return matcher.filter(files);
}
