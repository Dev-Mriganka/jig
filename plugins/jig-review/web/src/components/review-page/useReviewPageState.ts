import { askAgent, updateReviewSettings } from "@web/api.js";
import type { ReviewFile } from "@web/review-file.js";
import type { DraftComment, ReviewRecord, ReviewSettings } from "@web/types.js";
import { useMemo, useState } from "react";

import { getFileReviewMetrics, getGlobalDiffStats } from "./components/reviewMetrics.js";

type DraftsChangeHandler = (
  drafts: DraftComment[] | ((current: DraftComment[]) => DraftComment[]),
) => void;

type ReviewPageState = {
  addDraft: (draft: DraftComment) => void;
  askDraft: (draft: DraftComment) => Promise<void>;
  removeDraft: (draftId: string) => void;
  updateDraft: (draft: DraftComment) => void;
  changeViewType: (nextViewType: ReviewSettings["diffView"]) => void;
  fileMetrics: ReturnType<typeof getFileReviewMetrics>;
  globalStats: ReturnType<typeof getGlobalDiffStats>;
  isActionModalOpen: boolean;
  setIsActionModalOpen: (isOpen: boolean) => void;
  viewType: ReviewSettings["diffView"];
};

type ReviewPageStateOptions = {
  drafts: DraftComment[];
  files: ReviewFile[];
  onDraftsChange: DraftsChangeHandler;
  onReload: () => Promise<void>;
  review: ReviewRecord;
  settings: ReviewSettings;
};

/**
 * Centralizes derived review-page state and browser-triggered mutations.
 *
 * @param options Current review data and callbacks supplied by the app shell.
 * @returns Values and event handlers consumed by the review page layout.
 */
export function useReviewPageState(options: ReviewPageStateOptions): ReviewPageState {
  const [viewType, setViewType] = useState<ReviewSettings["diffView"]>(options.settings.diffView);
  const [isActionModalOpen, setIsActionModalOpen] = useState(false);
  const fileMetrics = useMemo(
    () => getFileReviewMetrics(options.files, options.drafts, options.review),
    [options.drafts, options.files, options.review],
  );
  const globalStats = useMemo(() => getGlobalDiffStats(options.files), [options.files]);

  const changeViewType = (nextViewType: ReviewSettings["diffView"]): void => {
    setViewType(nextViewType);
    void updateReviewSettings({ diffView: nextViewType });
  };

  const removeDraft = (draftId: string): void => {
    options.onDraftsChange((current) => current.filter((draft) => draft.id !== draftId));
  };

  const updateDraft = (updatedDraft: DraftComment): void => {
    options.onDraftsChange((current) =>
      current.map((draft) => (draft.id === updatedDraft.id ? updatedDraft : draft)),
    );
  };

  const askDraft = async (draft: DraftComment): Promise<void> => {
    await askAgent(draft);
    removeDraft(draft.id);
    await options.onReload();
  };

  const addDraft = (draft: DraftComment): void => {
    options.onDraftsChange((current) => [...current, draft]);
  };

  return {
    addDraft,
    askDraft,
    changeViewType,
    fileMetrics,
    globalStats,
    isActionModalOpen,
    removeDraft,
    setIsActionModalOpen,
    updateDraft,
    viewType,
  };
}
