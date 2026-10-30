import type { DraftComment, ReviewComment, ReviewResolution } from "@web/types.js";

export type ThreadResolution = {
  body?: string;
  resolution: ReviewResolution;
};

export type ReviewThread = {
  current: {
    comments: ReviewComment[];
    drafts: DraftComment[];
    resolutions: ThreadResolution[];
  };
  defaultCollapsed: boolean;
  filePath: string;
  isAgentAnswering: boolean;
  line: number;
  side: "old" | "new";
};

export type ReviewThreadMap = Map<string, ReviewThread>;
