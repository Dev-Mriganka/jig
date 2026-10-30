import { Button } from "@web/components/ui/index.js";
import type { DraftComment, ReviewRecord, ReviewSettings } from "@web/types.js";
import type { FC } from "react";

type ReviewHeaderProps = {
  drafts: DraftComment[];
  onOpenActions: () => void;
  onViewTypeChange: (viewType: ReviewSettings["diffView"]) => void;
  review: ReviewRecord;
  viewType: ReviewSettings["diffView"];
};

/**
 * Renders review identity, status, the diff view toggle, and the combined review action.
 */
export const ReviewHeader: FC<ReviewHeaderProps> = ({
  drafts,
  onOpenActions,
  onViewTypeChange,
  review,
  viewType,
}) => (
  <header className="sticky top-0 z-10 border-b border-slate-300 bg-white/95 px-6 py-4 shadow-sm backdrop-blur">
    <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">Jig code review</h1>
        <p className="text-sm text-slate-600">
          Review {review.id} · HEAD {review.headSha.slice(0, 12)} · {review.status}
          {review.pageApprovedAt !== undefined && review.status === "awaiting-review" ? " · approved in page, waiting for you in Pi" : ""}
        </p>
        <nav className="mt-1 flex gap-3 text-sm">
          <a className="text-blue-700 hover:underline" href="/reviews">
            Reviews
          </a>
          <a className="text-blue-700 hover:underline" href={`/review/${review.id}/conversation`}>
            Conversation
          </a>
          <a className="text-blue-700 hover:underline" href="/settings">
            Settings
          </a>
          <span className="font-medium text-slate-700">Files changed</span>
        </nav>
      </div>
      <div className="flex items-center gap-3">
        <div className="rounded-md border border-slate-300 bg-slate-100 p-1 text-sm">
          <button
            className={`rounded px-3 py-1 ${viewType === "split" ? "bg-white shadow-sm" : "text-slate-600"}`}
            onClick={() => {
              onViewTypeChange("split");
            }}
          >
            Split
          </button>
          <button
            className={`rounded px-3 py-1 ${viewType === "unified" ? "bg-white shadow-sm" : "text-slate-600"}`}
            onClick={() => {
              onViewTypeChange("unified");
            }}
          >
            Unified
          </button>
        </div>
        <Button
          className="px-4 py-2"
          disabled={review.status === "approved" || review.status === "awaiting-agent"}
          onClick={onOpenActions}
          variant="primary"
        >
          Finish review{drafts.length === 0 ? "" : ` (${drafts.length.toString()})`}
        </Button>
      </div>
    </div>
  </header>
);
