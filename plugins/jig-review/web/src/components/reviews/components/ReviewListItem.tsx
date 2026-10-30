import type { ReviewRecord } from "@web/types.js";
import type { FC } from "react";

import { ReviewStatusBadge } from "./ReviewStatusBadge.js";

type ReviewListItemProps = {
  isActive: boolean;
  review: ReviewRecord;
};

/**
 * Renders one review record in the review index.
 */
export const ReviewListItem: FC<ReviewListItemProps> = ({ isActive, review }) => (
  <a
    className="block rounded-xl border border-transparent bg-white p-5 shadow transition hover:border-blue-200 hover:bg-blue-50"
    href={`/review/${review.id}/conversation`}
  >
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate font-mono text-sm font-semibold text-slate-950">{review.id}</h2>
          <ReviewStatusBadge approval={review.approval} isActive={isActive} status={review.status} />
          {!isActive ? (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
              readonly
            </span>
          ) : undefined}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
          <span>{review.comments.length.toString()} comments</span>
          <span>{review.resolutions.length.toString()} agent responses</span>
          <span>{review.iterations.length.toString()} iterations</span>
          <span>{review.fileScope}</span>
        </div>
      </div>
      <div className="text-right text-xs text-slate-500">
        <div>Updated {formatDateTime(review.updatedAt)}</div>
        <div className="mt-1">HEAD {review.headSha.slice(0, 12)}</div>
      </div>
    </div>
  </a>
);

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
