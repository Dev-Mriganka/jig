import { getReviewFilePath, type ReviewFile } from "@web/review-file.js";
import type {
  DraftComment,
  ReviewComment,
  ReviewRecord,
  ReviewResolution,
  ReviewResolutionLocation,
} from "@web/types.js";
import type { ChangeData, ChangeEventArgs } from "react-diff-view";
import { getChangeKey, isDelete, isInsert, isNormal } from "react-diff-view";

import type { ReviewThread, ReviewThreadMap } from "./types.js";

export type SelectedLine = {
  changeKey: string;
  filePath: string;
  line: number;
  side: "old" | "new";
};

type BuildReviewThreadsOptions = {
  activeReview: ReviewRecord;
  drafts: DraftComment[];
  file: ReviewFile;
};

/**
 * Builds display-only thread data for the active review diff file.
 *
 * @param options Active review, draft comments, and parsed diff file.
 * @param options.activeReview Active review record that owns comments and lifecycle state.
 * @param options.drafts Local draft comments that have not been submitted yet.
 * @param options.file Parsed diff file whose lines can host inline threads.
 * @returns Threads keyed by react-diff-view change key for widget rendering.
 */
export function buildReviewThreads({
  activeReview,
  drafts,
  file,
}: BuildReviewThreadsOptions): ReviewThreadMap {
  const filePath = getReviewFilePath(file);
  const threads: ReviewThreadMap = new Map();

  addDraftsToThreads(threads, file, filePath, drafts);
  addActiveReviewToThreads(threads, file, filePath, activeReview);
  applyThreadReviewState(threads, activeReview);

  return threads;
}

/**
 * Converts a clicked diff line into an inline comment location.
 *
 * @param change Parsed diff change from react-diff-view.
 * @param side Side clicked by the user in split or unified diff view.
 * @param filePath Project path represented by the clicked diff file.
 * @returns Selected line metadata, or undefined when the change cannot host comments.
 */
export function getSelectedLine(
  change: ChangeData | null,
  side: ChangeEventArgs["side"],
  filePath: string,
): SelectedLine | undefined {
  if (change === null) {
    return undefined;
  }

  const line = getLineNumber(change, side);

  if (line === undefined) {
    return undefined;
  }

  return { changeKey: getChangeKey(change), filePath, line, side: getCommentSide(change, side) };
}

function addDraftsToThreads(
  threads: ReviewThreadMap,
  file: ReviewFile,
  filePath: string,
  drafts: DraftComment[],
): void {
  for (const draft of drafts.filter((draft) => isLineItemForFile(draft, filePath))) {
    getThread(threads, file, draft)?.current.drafts.push(draft);
  }
}

function addActiveReviewToThreads(
  threads: ReviewThreadMap,
  file: ReviewFile,
  filePath: string,
  review: ReviewRecord,
): void {
  const resolutionsById = getResolutionsById(review);

  for (const comment of review.comments.filter((comment) => isLineItemForFile(comment, filePath))) {
    const thread = getThread(threads, file, comment);

    if (thread === undefined) {
      continue;
    }

    thread.current.comments.push(comment);
    addCommentResolution(comment, resolutionsById, thread.current.resolutions);
  }

  addResolutionLocationsToThreads(review.resolutions, file, filePath, threads);
}

function addResolutionLocationsToThreads(
  resolutions: ReviewResolution[],
  file: ReviewFile,
  filePath: string,
  threads: ReviewThreadMap,
): void {
  for (const resolution of resolutions) {
    for (const location of resolution.addressedLocations ?? []) {
      if (!isLineItemForFile(location, filePath)) {
        continue;
      }

      const thread = getThread(threads, file, location);

      if (thread !== undefined) {
        addUniqueResolution(thread.current.resolutions, { body: location.body, resolution });
      }
    }
  }
}

function addCommentResolution(
  comment: ReviewComment,
  resolutionsById: Map<string, ReviewResolution>,
  resolutions: ReviewThread["current"]["resolutions"],
): void {
  const resolution =
    comment.resolutionId === undefined ? undefined : resolutionsById.get(comment.resolutionId);

  if (resolution !== undefined) {
    addUniqueResolution(resolutions, { resolution });
  }
}

function addUniqueResolution(
  resolutions: ReviewThread["current"]["resolutions"],
  item: ReviewThread["current"]["resolutions"][number],
): void {
  if (!resolutions.some((existing) => existing.resolution.id === item.resolution.id)) {
    resolutions.push(item);
  }
}

function getThread(
  threads: ReviewThreadMap,
  file: ReviewFile,
  item: DraftComment | ReviewComment | ReviewResolutionLocation,
): ReviewThread | undefined {
  if (item.line === undefined) {
    return undefined;
  }

  const changeKey = getChangeKeyForLine(file, item.line, item.side);

  if (changeKey === undefined) {
    return undefined;
  }

  const thread = threads.get(changeKey) ?? createThread(file, item);

  threads.set(changeKey, thread);

  return thread;
}

function createThread(
  file: ReviewFile,
  item: DraftComment | ReviewComment | ReviewResolutionLocation,
): ReviewThread {
  return {
    current: { comments: [], drafts: [], resolutions: [] },
    defaultCollapsed: false,
    filePath: getReviewFilePath(file),
    isAgentAnswering: false,
    line: item.line ?? 0,
    side: item.side ?? "new",
  };
}

function applyThreadReviewState(threads: ReviewThreadMap, review: ReviewRecord): void {
  for (const thread of threads.values()) {
    thread.defaultCollapsed = !hasRecentThreadActivity(thread, review);
    thread.isAgentAnswering = review.status === "awaiting-agent";
  }
}

function hasRecentThreadActivity(thread: ReviewThread, review: ReviewRecord): boolean {
  const iteration = getRecentDiscussionIteration(review);

  if (iteration === undefined) {
    return false;
  }

  const recentCommentIds = new Set(iteration.submittedCommentIds);
  const recentResolutionIds = new Set(iteration.resolutionIds);

  return (
    thread.current.drafts.length > 0 ||
    thread.current.comments.some((comment) => recentCommentIds.has(comment.id)) ||
    thread.current.resolutions.some((item) => recentResolutionIds.has(item.resolution.id))
  );
}

function getRecentDiscussionIteration(
  review: ReviewRecord,
): ReviewRecord["iterations"][number] | undefined {
  return [...review.iterations]
    .reverse()
    .find(
      (iteration) => iteration.submittedCommentIds.length > 0 || iteration.resolutionIds.length > 0,
    );
}

function getChangeKeyForLine(
  file: ReviewFile,
  line: number | undefined,
  side: "old" | "new" | undefined,
): string | undefined {
  if (line === undefined) {
    return undefined;
  }

  const expectedSide = side ?? "new";
  const change = file.hunks
    .flatMap((hunk) => hunk.changes)
    .find(
      (item) =>
        getLineNumber(item, expectedSide) === line &&
        getCommentSide(item, expectedSide) === expectedSide,
    );

  return change === undefined ? undefined : getChangeKey(change);
}

function getLineNumber(change: ChangeData, side: ChangeEventArgs["side"]): number | undefined {
  if (isNormal(change)) {
    return side === "old" ? change.oldLineNumber : change.newLineNumber;
  }

  if (isInsert(change) || isDelete(change)) {
    return change.lineNumber;
  }

  return undefined;
}

function getCommentSide(change: ChangeData, side: ChangeEventArgs["side"]): "old" | "new" {
  if (isDelete(change)) {
    return "old";
  }

  if (isInsert(change)) {
    return "new";
  }

  return side === "old" ? "old" : "new";
}

function getResolutionsById(review: ReviewRecord): Map<string, ReviewResolution> {
  return new Map(review.resolutions.map((resolution) => [resolution.id, resolution]));
}

function isLineItemForFile(
  item: DraftComment | ReviewComment | ReviewResolutionLocation,
  filePath: string,
): boolean {
  return item.filePath === filePath && item.line !== undefined;
}
