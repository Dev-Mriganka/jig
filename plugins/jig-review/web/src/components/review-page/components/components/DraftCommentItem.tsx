import type { DraftComment } from "@web/types.js";
import type { FC } from "react";

type DraftCommentItemProps = {
  draft: DraftComment;
};

/**
 * Renders one draft review comment in passive draft summaries.
 */
export const DraftCommentItem: FC<DraftCommentItemProps> = ({ draft }) => (
  <li className="rounded border border-slate-200 p-2">
    <div className="font-mono text-xs text-slate-500">
      {draft.filePath ?? "General"}
      {draft.line === undefined ? "" : `:${draft.line.toString()}`}
    </div>
    <p className="mt-1 whitespace-pre-wrap">{draft.body}</p>
  </li>
);
