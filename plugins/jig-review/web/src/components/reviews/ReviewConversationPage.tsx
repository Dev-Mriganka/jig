import { ConversationDiffSnippet } from "@web/components/review-page/components/ConversationDiffSnippet.js";
import { ConversationMessageBubble } from "@web/components/review-page/components/ConversationMessageBubble.js";
import type { ReviewComment, ReviewRecord, ReviewResolution } from "@web/types.js";
import type { FC, ReactNode } from "react";

import { ReviewNavigation } from "./components/ReviewNavigation.js";

type ReviewConversationPageProps = {
  isActive: boolean;
  review: ReviewRecord;
};

/**
 * Shows review-level discussion and lifecycle events separately from file diffs.
 */
export const ReviewConversationPage: FC<ReviewConversationPageProps> = ({ isActive, review }) => {
  const events = getReviewEvents(review);

  return (
    <main className="min-h-screen bg-slate-100 p-6 text-slate-950">
      <div className="mx-auto max-w-5xl space-y-4">
        <ReviewNavigation currentPage="conversation" isActive={isActive} review={review} />
        <section className="grid gap-4 md:grid-cols-4">
          {renderSummaryCard("Comments", review.comments.length)}
          {renderSummaryCard("Agent responses", review.resolutions.length)}
          {renderSummaryCard("Iterations", review.iterations.length)}
          {renderSummaryCard("Files scope", review.fileScope)}
        </section>
        <section className="rounded-xl bg-white p-5 shadow">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Conversation</h2>
              <p className="mt-1 text-sm text-slate-600">
                Review comments, agent responses, and lifecycle events for this review record.
              </p>
            </div>
            {!isActive ? (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                Readonly
              </span>
            ) : undefined}
          </div>
          <div className="mt-5 space-y-4 border-l-2 border-slate-200 pl-4">
            {events.map((event) => (
              <div className="relative" key={event.key}>
                <span className="absolute left-[-1.42rem] top-3 h-3 w-3 rounded-full border-2 border-white bg-slate-300" />
                {event.node}
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
};

type ReviewEvent = {
  key: string;
  node: ReactNode;
  timestamp: string;
};

function getReviewEvents(review: ReviewRecord): ReviewEvent[] {
  const events: ReviewEvent[] = [
    {
      key: `${review.id}-created`,
      timestamp: review.createdAt,
      node: (
        <ConversationMessageBubble
          body={`Review created against HEAD ${review.headSha.slice(0, 12)}.`}
          meta={formatDateTime(review.createdAt)}
          speaker="system"
          title="Review created"
        />
      ),
    },
    ...review.comments.map((comment) => getCommentEvent(comment)),
    ...review.resolutions.map((resolution) => getResolutionEvent(resolution)),
    ...review.iterations.slice(1).map((iteration) => ({
      key: `${review.id}-iteration-${iteration.id.toString()}`,
      timestamp: iteration.createdAt,
      node: (
        <ConversationMessageBubble
          body={`Agent response recorded; diff iteration ${iteration.id.toString()} created.`}
          meta={formatDateTime(iteration.createdAt)}
          speaker="system"
          title="New diff iteration"
        />
      ),
    })),
  ];

  if (review.approvedAt !== undefined) {
    events.push({
      key: `${review.id}-approved`,
      timestamp: review.approvedAt,
      node: (
        <ConversationMessageBubble
          body={getApprovalText(review)}
          meta={formatDateTime(review.approvedAt)}
          speaker="system"
          title="Approved"
        />
      ),
    });
  }

  return events.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function getApprovalText(review: ReviewRecord): string {
  if (review.approval?.method === "passkey") {
    return `Review approved with a passkey${review.approval.fingerprint === undefined ? "" : ` (key ${review.approval.fingerprint.slice(0, 16)})`}.`;
  }

  return review.approval === undefined ? "Review approved." : "Review approved in the page, then with a y in Pi.";
}

function getCommentEvent(comment: ReviewComment): ReviewEvent {
  return {
    key: comment.id,
    timestamp: comment.createdAt,
    node: (
      <ConversationMessageBubble
        body={comment.body}
        footer={renderCommentFooter(comment)}
        meta={["You", formatDateTime(comment.createdAt), comment.status]
          .filter(Boolean)
          .join(" · ")}
        speaker="user"
        title={`Comment · ${formatLocation(comment)}`}
      />
    ),
  };
}

function getResolutionEvent(resolution: ReviewResolution): ReviewEvent {
  return {
    key: resolution.id,
    timestamp: resolution.createdAt,
    node: (
      <ConversationMessageBubble
        body={resolution.summary}
        footer={
          resolution.beforeAfter === undefined ? undefined : (
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium text-emerald-800">Changed diff</div>
              <ConversationDiffSnippet diff={resolution.beforeAfter} />
            </div>
          )
        }
        meta={["Agent", formatDateTime(resolution.createdAt), resolution.kind].join(" · ")}
        speaker="agent"
        title="Agent response"
      />
    ),
  };
}

function renderSummaryCard(label: string, value: number | string): ReactNode {
  return (
    <div className="rounded-xl bg-white p-4 shadow">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-950">{value}</div>
    </div>
  );
}

function renderCommentFooter(comment: ReviewComment): ReactNode {
  if (comment.filePath === undefined) {
    return undefined;
  }

  return (
    <a
      className="mt-2 inline-flex text-xs font-medium text-blue-700 hover:underline"
      href={getFileLink(comment)}
    >
      Open in files changed
    </a>
  );
}

function getFileLink(comment: ReviewComment): string {
  const filePath = comment.filePath ?? "";

  return `/review/${window.location.pathname.split("/")[2] ?? ""}/files#file-${filePath.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function formatLocation(comment: ReviewComment): string {
  if (comment.filePath === undefined) {
    return "General";
  }

  return comment.line === undefined
    ? comment.filePath
    : `${comment.filePath}:${comment.line.toString()} ${comment.side ?? "new"}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
