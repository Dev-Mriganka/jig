import type { DraftComment, ReviewRecord, ReviewSettings } from "@web/types.js";
import type { FC } from "react";

import { DiffList } from "./DiffList.js";
import { FileExplorer } from "./FileExplorer.js";
import type { DiffStats, FileReviewMetrics } from "./reviewMetrics.js";
import { ReviewSidebar } from "./ReviewSidebar.js";

type ReviewPageLayoutProps = {
  addDraft: (draft: DraftComment) => void;
  askDraft: (draft: DraftComment) => Promise<void>;
  drafts: DraftComment[];
  removeDraft: (draftId: string) => void;
  review: ReviewRecord;
  updateDraft: (draft: DraftComment) => void;
  fileMetrics: FileReviewMetrics[];
  globalStats: DiffStats;
  viewType: ReviewSettings["diffView"];
};

/**
 * Renders the three-column review workspace: explorer, diff, and summary.
 */
export const ReviewPageLayout: FC<ReviewPageLayoutProps> = ({
  addDraft,
  askDraft,
  drafts,
  removeDraft,
  review,
  updateDraft,
  fileMetrics,
  globalStats,
  viewType,
}) => (
  <div className="grid w-full grid-cols-[300px_minmax(0,1fr)_280px] gap-4 px-4 py-6">
    <FileExplorer files={fileMetrics} />
    <DiffList
      drafts={drafts}
      files={fileMetrics.map((file) => file.file)}
      onAddDraft={addDraft}
      onAskDraft={askDraft}
      onRemoveDraft={removeDraft}
      onUpdateDraft={updateDraft}
      review={review}
      viewType={viewType}
    />
    <ReviewSidebar drafts={drafts} files={fileMetrics} globalStats={globalStats} review={review} />
  </div>
);
