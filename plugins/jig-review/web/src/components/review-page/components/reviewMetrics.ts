import { getReviewFilePath, type ReviewFile } from "@web/review-file.js";
import type { DraftComment, ReviewRecord } from "@web/types.js";
import { isDelete, isInsert, parseDiff } from "react-diff-view";

export type DiffStats = {
  added: number;
  deleted: number;
};

export type FileReviewMetrics = {
  anchorId: string;
  file: ReviewFile;
  changedSinceLastReview: boolean;
  filePath: string;
  messages: number;
  stats: DiffStats;
};

/**
 * Builds per-file metrics for navigation, diff stats, and discussion counts.
 *
 * @param files Changed files parsed from the active review diff.
 * @param drafts Local draft comments that have not been submitted yet.
 * @param review Active review record with submitted comments and resolutions.
 * @returns Per-file review metrics for sidebar and navigation UI.
 */
export function getFileReviewMetrics(
  files: ReviewFile[],
  drafts: DraftComment[],
  review: ReviewRecord,
): FileReviewMetrics[] {
  return files
    .map((file) => {
      const filePath = getReviewFilePath(file);

      return {
        anchorId: getFileAnchorId(file),
        changedSinceLastReview: isFileChangedSinceLastReview(file, review),
        file,
        filePath,
        messages: getFileMessageCount(filePath, drafts, review),
        stats: getFileDiffStats(file),
      };
    })
    .sort((left, right) => compareFilePaths(left.filePath, right.filePath));
}

/**
 * Sums added and deleted line counts across all files.
 *
 * @param files Changed files parsed from the active review diff.
 * @returns Global diff line totals.
 */
export function getGlobalDiffStats(files: ReviewFile[]): DiffStats {
  return files.reduce(
    (total, file) => {
      const stats = getFileDiffStats(file);

      return {
        added: total.added + stats.added,
        deleted: total.deleted + stats.deleted,
      };
    },
    { added: 0, deleted: 0 },
  );
}

/**
 * Creates a stable DOM id for a changed file section.
 *
 * @param file Changed file parsed from the active review diff.
 * @returns File section anchor id.
 */
export function getFileAnchorId(file: ReviewFile): string {
  return `file-${getReviewFilePath(file).replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function compareFilePaths(left: string, right: string): number {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const length = Math.min(leftSegments.length, rightSegments.length);

  for (let index = 0; index < length; index += 1) {
    const leftSegment = leftSegments[index] ?? "";
    const rightSegment = rightSegments[index] ?? "";

    if (leftSegment !== rightSegment) {
      const leftIsFolder = index < leftSegments.length - 1;
      const rightIsFolder = index < rightSegments.length - 1;

      if (leftIsFolder !== rightIsFolder) {
        return leftIsFolder ? -1 : 1;
      }

      return leftSegment.localeCompare(rightSegment);
    }
  }

  return rightSegments.length - leftSegments.length;
}

function getFileDiffStats(file: ReviewFile): DiffStats {
  return file.hunks
    .flatMap((hunk) => hunk.changes)
    .reduce(
      (stats, change) => ({
        added: stats.added + (isInsert(change) ? 1 : 0),
        deleted: stats.deleted + (isDelete(change) ? 1 : 0),
      }),
      { added: 0, deleted: 0 },
    );
}

function getFileMessageCount(
  filePath: string,
  drafts: DraftComment[],
  review: ReviewRecord,
): number {
  return (
    drafts.filter((draft) => draft.filePath === filePath).length +
    getReviewFileMessageCount(filePath, review)
  );
}

function getReviewFileMessageCount(filePath: string, review: ReviewRecord): number {
  const fileComments = review.comments.filter((comment) => comment.filePath === filePath);
  const fileResolutionIds = new Set(
    fileComments.flatMap((comment) =>
      comment.resolutionId === undefined ? [] : [comment.resolutionId],
    ),
  );

  for (const resolution of review.resolutions) {
    if (
      resolution.addressedLocations?.some((location) => location.filePath === filePath) === true
    ) {
      fileResolutionIds.add(resolution.id);
    }
  }

  return fileComments.length + fileResolutionIds.size;
}

function isFileChangedSinceLastReview(file: ReviewFile, review: ReviewRecord): boolean {
  if (review.iterations.length < 2) {
    return false;
  }

  const previousFiles = parseDiff(review.iterations.at(-2)?.diff ?? "");
  const previousFile = previousFiles.find(
    (item) => getReviewFilePath(item) === getReviewFilePath(file),
  );

  return (
    previousFile === undefined ||
    getComparableFileDiff(previousFile) !== getComparableFileDiff(file)
  );
}

function getComparableFileDiff(file: ReviewFile): string {
  return JSON.stringify(file.hunks);
}
