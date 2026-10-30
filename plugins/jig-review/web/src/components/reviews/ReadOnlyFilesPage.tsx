import { getReviewFilePath } from "@web/review-file.js";
import type { ReviewRecord } from "@web/types.js";
import type { FC } from "react";
import { Diff, Hunk, parseDiff } from "react-diff-view";

import { getTokens } from "../review-page/components/diffFileHelpers.js";
import { ReviewNavigation } from "./components/ReviewNavigation.js";

type ReadOnlyFilesPageProps = {
  isActive: boolean;
  review: ReviewRecord;
};

/**
 * Shows a readonly diff snapshot for approved, abandoned, or otherwise inactive reviews.
 */
export const ReadOnlyFilesPage: FC<ReadOnlyFilesPageProps> = ({ isActive, review }) => {
  const files = parseDiff(review.iterations.at(-1)?.diff ?? "");

  return (
    <main className="min-h-screen bg-slate-100 p-6 text-slate-950">
      <div className="mx-auto max-w-6xl space-y-4">
        <ReviewNavigation currentPage="files" isActive={isActive} review={review} />
        {files.map((file) => (
          <article className="rounded-lg bg-white shadow" key={`${file.oldPath}-${file.newPath}`}>
            <header className="border-b border-slate-200 px-4 py-3 font-mono text-sm font-semibold">
              {getReviewFilePath(file)}
            </header>
            <div className="overflow-x-auto text-sm">
              <Diff
                diffType={file.type}
                hunks={file.hunks}
                tokens={getTokens(file)}
                viewType="split"
              >
                {(hunks) => hunks.map((hunk) => <Hunk hunk={hunk} key={hunk.content} />)}
              </Diff>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
};
