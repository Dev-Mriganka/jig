import type { DraftComment } from "@web/types.js";
import type { FC } from "react";

import { DraftCommentItem } from "./components/DraftCommentItem.js";

type DraftCommentListProps = {
  drafts: DraftComment[];
};

/**
 * Lists draft comments that will be included in the next batched review submission.
 */
export const DraftCommentList: FC<DraftCommentListProps> = ({ drafts }) => (
  <ul className="mt-3 space-y-2 text-sm">
    {drafts.map((draft) => (
      <DraftCommentItem draft={draft} key={draft.id} />
    ))}
  </ul>
);
