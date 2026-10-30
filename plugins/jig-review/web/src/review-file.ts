import { parseDiff } from "react-diff-view";

export type ReviewFile = ReturnType<typeof parseDiff>[number];

/**
 * Returns the project file path represented by a parsed diff file.
 *
 * @param file Parsed diff file whose old or new side may be `/dev/null`.
 * @returns Non-dev-null project path for display, anchors, and comment matching.
 */
export function getReviewFilePath(file: ReviewFile): string {
  if (file.newPath.length > 0 && file.newPath !== "/dev/null") {
    return file.newPath;
  }

  return file.oldPath;
}
