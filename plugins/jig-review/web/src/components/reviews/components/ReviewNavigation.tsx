import type { ReviewRecord } from "@web/types.js";
import type { FC } from "react";

import { ReviewStatusBadge } from "./ReviewStatusBadge.js";

type ReviewNavigationProps = {
  currentPage: "conversation" | "files";
  isActive: boolean;
  review: ReviewRecord;
};

/**
 * Renders polished navigation between review list, conversation, and files pages.
 */
export const ReviewNavigation: FC<ReviewNavigationProps> = ({ currentPage, isActive, review }) => (
  <header className="rounded-xl bg-white p-4 shadow">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <a className="font-medium text-blue-700 hover:underline" href="/reviews">
            Reviews
          </a>
          <a className="font-medium text-blue-700 hover:underline" href="/settings">
            Settings
          </a>
          <span>/</span>
          <span className="font-mono">{review.id}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-950">Code review</h1>
          <ReviewStatusBadge approval={review.approval} isActive={isActive} status={review.status} />
          {!isActive ? (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
              readonly
            </span>
          ) : undefined}
        </div>
        <p className="mt-1 text-sm text-slate-600">
          HEAD {review.headSha.slice(0, 12)} · {review.fileScope} · updated{" "}
          {formatDateTime(review.updatedAt)}
        </p>
      </div>
      <nav className="flex rounded-lg border border-slate-200 bg-slate-50 p-1 text-sm font-medium">
        <a
          className={getTabClassName(currentPage === "conversation")}
          href={`/review/${review.id}/conversation`}
        >
          Conversation
        </a>
        <a className={getTabClassName(currentPage === "files")} href={`/review/${review.id}/files`}>
          Files changed
        </a>
      </nav>
    </div>
  </header>
);

function getTabClassName(isActive: boolean): string {
  const baseClassName = "rounded-md px-3 py-1.5 transition";

  return isActive
    ? `${baseClassName} bg-white text-slate-950 shadow-sm`
    : `${baseClassName} text-slate-600 hover:text-blue-700`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
