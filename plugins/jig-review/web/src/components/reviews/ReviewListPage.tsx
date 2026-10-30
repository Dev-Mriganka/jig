import type { ReviewRecord } from "@web/types.js";
import type { FC } from "react";

import { ReviewListItem } from "./components/ReviewListItem.js";

type ReviewListPageProps = {
  activeReviewId?: string;
  reviews: ReviewRecord[];
};

/**
 * Lists persisted reviews so users can open active or readonly review records.
 */
export const ReviewListPage: FC<ReviewListPageProps> = ({ activeReviewId, reviews }) => (
  <main className="min-h-screen bg-slate-100 p-6 text-slate-950">
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="rounded-xl bg-white p-6 shadow">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium uppercase tracking-wide text-blue-700">Jig code review</p>
          <a className="text-sm font-medium text-blue-700 hover:underline" href="/settings">
            Settings
          </a>
        </div>
        <h1 className="mt-1 text-3xl font-semibold">Reviews</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Open the active review to continue working, or inspect approved and abandoned records in
          readonly mode.
        </p>
      </header>
      {reviews.length === 0 ? (
        <p className="rounded-xl bg-white p-5 text-slate-600 shadow">No reviews found.</p>
      ) : (
        <div className="grid gap-3">
          {reviews.map((review) => (
            <ReviewListItem
              isActive={review.id === activeReviewId}
              key={review.id}
              review={review}
            />
          ))}
        </div>
      )}
    </div>
  </main>
);
