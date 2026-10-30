import type { ReviewFile } from "@web/review-file.js";
import type { DraftComment, ReviewRecord, ReviewSettings } from "@web/types.js";
import type { FC } from "react";

import { DiffFile } from "./DiffFile.js";

type DiffListProps = {
  drafts: DraftComment[];
  files: ReviewFile[];
  onAddDraft: (comment: DraftComment) => void;
  onAskDraft: (comment: DraftComment) => Promise<void>;
  onRemoveDraft: (draftId: string) => void;
  onUpdateDraft: (draft: DraftComment) => void;
  review: ReviewRecord;
  viewType: ReviewSettings["diffView"];
};

/**
 * Renders all changed files in the active review iteration.
 */
export const DiffList: FC<DiffListProps> = ({
  drafts,
  files,
  onAddDraft,
  onAskDraft,
  onRemoveDraft,
  onUpdateDraft,
  review,
  viewType,
}) => (
  <section className="space-y-6">
    {files.map((file) => (
      <DiffFile
        drafts={drafts}
        file={file}
        key={`${file.oldPath}-${file.newPath}`}
        onAddDraft={onAddDraft}
        onAskDraft={onAskDraft}
        onRemoveDraft={onRemoveDraft}
        onUpdateDraft={onUpdateDraft}
        review={review}
        viewType={viewType}
      />
    ))}
  </section>
);
