import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseDiff } from "react-diff-view";

import { fetchReviewById, fetchReviews, getReviewApiUrl } from "./api.js";
import { ReviewPage } from "./components/review-page/index.js";
import { ReadOnlyFilesPage } from "./components/reviews/ReadOnlyFilesPage.js";
import { ReviewConversationPage } from "./components/reviews/ReviewConversationPage.js";
import { ReviewListPage } from "./components/reviews/ReviewListPage.js";
import { SettingsPage } from "./components/settings/SettingsPage.js";
import type { DraftComment, ReviewListPayload, ReviewRecord, ReviewSettings } from "./types.js";

type Route =
  | { name: "reviews" }
  | { name: "settings" }
  | { id: string; name: "conversation" }
  | { id: string; name: "files" };

/**
 * Renders the browser review application.
 */
// eslint-disable-next-line max-lines-per-function -- Top-level route loading and page selection belong in the app shell.
export const App: FC = () => {
  const route = useBrowserRoute();
  const [reviewList, setReviewList] = useState<ReviewListPayload>();
  const [review, setReview] = useState<ReviewRecord>();
  const [isActiveReview, setIsActiveReview] = useState(false);
  const [settings, setSettings] = useState<ReviewSettings>();
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const [generalComment, setGeneralComment] = useState("");
  const [error, setError] = useState<string>();

  const reload = useCallback(async (): Promise<void> => {
    try {
      if (route.name === "settings") {
        return;
      }

      if (route.name === "reviews") {
        setReviewList(await fetchReviews());
        setReview(undefined);
      } else {
        const payload = await fetchReviewById(route.id);

        setIsActiveReview(payload.isActive);
        setReview(payload.review);
        setSettings(payload.settings);
        setReviewList(undefined);
      }

      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load review.");
    }
  }, [route]);

  useReviewUpdates(reload);

  const files = useMemo(() => parseDiff(review?.iterations.at(-1)?.diff ?? ""), [review]);

  useHashAnchorScroll(review?.id, files.length);

  if (error !== undefined) {
    return <div className="mx-auto max-w-3xl p-8 text-red-700">{error}</div>;
  }

  if (route.name === "settings") {
    return <SettingsPage />;
  }

  if (route.name === "reviews") {
    return reviewList === undefined ? (
      <div className="mx-auto max-w-3xl p-8">Loading reviews…</div>
    ) : (
      <ReviewListPage activeReviewId={reviewList.activeReviewId} reviews={reviewList.reviews} />
    );
  }

  if (review === undefined || settings === undefined) {
    return <div className="mx-auto max-w-3xl p-8">Loading review…</div>;
  }

  if (route.name === "conversation") {
    return <ReviewConversationPage isActive={isActiveReview} review={review} />;
  }

  if (!isActiveReview) {
    return <ReadOnlyFilesPage isActive={isActiveReview} review={review} />;
  }

  return (
    <ReviewPage
      drafts={drafts}
      files={files}
      generalComment={generalComment}
      onDraftsChange={setDrafts}
      onGeneralCommentChange={setGeneralComment}
      onReload={reload}
      review={review}
      settings={settings}
    />
  );
};

function useBrowserRoute(): Route {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const updatePath = (): void => {
      setPath(window.location.pathname);
    };

    window.addEventListener("popstate", updatePath);

    return (): void => {
      window.removeEventListener("popstate", updatePath);
    };
  }, []);

  return useMemo(() => {
    const match = /^\/review\/([^/]+)\/(conversation|files)$/.exec(path);
    const id = match?.[1];

    if (id !== undefined) {
      return {
        id: decodeURIComponent(id),
        name: match?.[2] === "files" ? "files" : "conversation",
      };
    }

    return path === "/settings" ? { name: "settings" } : { name: "reviews" };
  }, [path]);
}

function useHashAnchorScroll(reviewId: string | undefined, fileCount: number): void {
  useEffect(() => {
    if (reviewId === undefined || fileCount === 0 || window.location.hash.length === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
    });

    return (): void => {
      window.cancelAnimationFrame(frame);
    };
  }, [fileCount, reviewId]);
}

function useReviewUpdates(reload: () => Promise<void>): void {
  useEffect(() => {
    void reload();

    const events = new EventSource(getReviewApiUrl("/api/events"));
    let hasConnected = false;

    events.addEventListener("connected", () => {
      hasConnected = true;
    });

    events.addEventListener("review-updated", () => {
      void reload();
    });

    events.addEventListener("error", () => {
      if (!hasConnected) {
        events.close();
      }
    });

    return (): void => {
      events.close();
    };
  }, [reload]);
}
