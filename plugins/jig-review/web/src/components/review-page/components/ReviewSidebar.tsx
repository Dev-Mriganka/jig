import type { DraftComment, ReviewRecord } from "@web/types.js";
import type { FC, ReactNode } from "react";

import { DraftCommentList } from "./DraftCommentList.js";
import type { DiffStats, FileReviewMetrics } from "./reviewMetrics.js";

type ReviewSidebarProps = {
  drafts: DraftComment[];
  files: FileReviewMetrics[];
  globalStats: DiffStats;
  review: ReviewRecord;
};

/**
 * Renders sticky review totals and draft summary while conversations stay inline on diff lines.
 */
export const ReviewSidebar: FC<ReviewSidebarProps> = ({ drafts, files, globalStats, review }) => (
  <aside className="sticky top-24 max-h-[calc(100vh-7rem)] space-y-4 overflow-y-auto">
    <section className="rounded-lg bg-white p-4 shadow">
      <h2 className="font-semibold">Review summary</h2>
      <dl className="mt-3 space-y-2 text-sm text-slate-600">
        {renderSummaryRow("Files", files.length.toString())}
        {renderSummaryRow("Added", `+${globalStats.added.toString()}`, "text-emerald-700")}
        {renderSummaryRow("Deleted", `-${globalStats.deleted.toString()}`, "text-red-700")}
        {renderSummaryRow("Drafts", drafts.length.toString())}
        {renderSummaryRow("Messages", getTotalMessageCount(review).toString())}
      </dl>
      <p className="mt-3 text-xs text-slate-500">
        Conversations and replies stay on their diff lines.
      </p>
    </section>
    {drafts.length === 0 ? undefined : (
      <section className="rounded-lg bg-white p-4 shadow">
        <h2 className="font-semibold">Drafts</h2>
        <DraftCommentList drafts={drafts} />
      </section>
    )}
  </aside>
);

function getTotalMessageCount(review: ReviewRecord): number {
  return review.comments.length + review.resolutions.length;
}

function renderSummaryRow(label: string, value: string, valueClassName?: string): ReactNode {
  return (
    <div className="flex justify-between gap-3" key={label}>
      <dt>{label}</dt>
      <dd className={valueClassName}>{value}</dd>
    </div>
  );
}
