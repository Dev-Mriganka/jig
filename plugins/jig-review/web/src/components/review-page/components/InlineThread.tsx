import type { ReviewThread, ThreadResolution } from "@web/discussions/types.js";
import type { DraftComment, ReviewComment, ReviewResolution } from "@web/types.js";
import type { FC, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { DraftConversationMessage } from "./components/DraftConversationMessage.js";
import { ConversationDiffSnippet } from "./ConversationDiffSnippet.js";
import {
  ConversationMessageBubble,
  type ConversationSpeaker,
} from "./ConversationMessageBubble.js";
import { InlineCommentForm } from "./InlineCommentForm.js";

type InlineThreadProps = {
  onAddDraft: (comment: DraftComment) => void;
  onAskDraft: (comment: DraftComment) => Promise<void>;
  onRemoveDraft: (draftId: string) => void;
  onUpdateDraft: (draft: DraftComment) => void;
  thread: ReviewThread;
};

/**
 * Shows current user/agent discussion next to the diff line it belongs to.
 */
export const InlineThread: FC<InlineThreadProps> = ({
  onAddDraft,
  onAskDraft,
  onRemoveDraft,
  onUpdateDraft,
  thread,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(thread.defaultCollapsed);
  const messages = getConversationMessages({ onAskDraft, onRemoveDraft, onUpdateDraft, thread });
  const previousMessageCount = useRef(messages.length);
  const hasNewMessageActivity =
    thread.current.drafts.length > 0 ||
    thread.current.comments.some((comment) => comment.status === "submitted");
  const isThreadCollapsed = isCollapsed && !hasNewMessageActivity;

  useEffect(() => {
    if (!thread.defaultCollapsed || messages.length > previousMessageCount.current) {
      setIsCollapsed(false);
    }

    previousMessageCount.current = messages.length;
  }, [messages.length, thread.defaultCollapsed]);

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-white p-3 shadow-sm">
      <button
        className="flex w-full items-center justify-between text-left text-sm font-medium text-slate-700"
        onClick={() => {
          setIsCollapsed((current) => !current);
        }}
        type="button"
      >
        <span>Conversation · {messages.length.toString()} messages</span>
        <span className="text-xs text-slate-500">{isThreadCollapsed ? "Expand" : "Collapse"}</span>
      </button>
      {isThreadCollapsed ? undefined : (
        <div className="space-y-2">
          {messages.map((item) => item.node)}
          <InlineCommentForm
            autoFocus={false}
            filePath={thread.filePath}
            line={thread.line}
            onAsk={onAskDraft}
            onSubmit={onAddDraft}
            side={thread.side}
          />
        </div>
      )}
    </div>
  );
};

type ConversationMessage = {
  createdAt: string;
  node: ReactNode;
};

type ConversationMessageOptions = Pick<
  InlineThreadProps,
  "onAskDraft" | "onRemoveDraft" | "onUpdateDraft" | "thread"
>;

function getConversationMessages(options: ConversationMessageOptions): ConversationMessage[] {
  const latestResolutionId = getLatestResolutionId(options.thread.current.resolutions);
  const resolutionsById = new Map(
    options.thread.current.resolutions.map(
      (item) => [item.resolution.id, item] satisfies [string, ThreadResolution],
    ),
  );
  const renderedResolutionIds = new Set<string>();
  const messages: ConversationMessage[] = [
    ...options.thread.current.drafts.map((draft) =>
      getDraftMessage({
        draft,
        onAskDraft: options.onAskDraft,
        onRemoveDraft: options.onRemoveDraft,
        onUpdateDraft: options.onUpdateDraft,
      }),
    ),
    ...options.thread.current.comments.flatMap((comment) =>
      getCommentMessages({
        comment,
        isAgentAnswering: options.thread.isAgentAnswering,
        latestResolutionId,
        renderedResolutionIds,
        resolutionsById,
      }),
    ),
  ];

  messages.push(
    ...options.thread.current.resolutions
      .filter((item) => !renderedResolutionIds.has(item.resolution.id))
      .map((item) => getAgentMessage(item, item.resolution.id !== latestResolutionId)),
  );

  return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

type DraftMessageOptions = {
  draft: DraftComment;
  onAskDraft: (draft: DraftComment) => Promise<void>;
  onRemoveDraft: (draftId: string) => void;
  onUpdateDraft: (draft: DraftComment) => void;
};

function getDraftMessage(options: DraftMessageOptions): ConversationMessage {
  return {
    createdAt: new Date().toISOString(),
    node: <DraftConversationMessage key={options.draft.id} {...options} />,
  };
}

type SubmittedCommentOptions = {
  comment: ReviewComment;
  isAgentAnswering: boolean;
  latestResolutionId: string | undefined;
  renderedResolutionIds: Set<string>;
  resolutionsById: Map<string, ThreadResolution>;
};

function getCommentMessages(options: SubmittedCommentOptions): ConversationMessage[] {
  const resolution =
    options.comment.resolutionId === undefined
      ? undefined
      : options.resolutionsById.get(options.comment.resolutionId);
  const messages: ConversationMessage[] = [getUserCommentMessage(options.comment)];

  if (resolution !== undefined) {
    options.renderedResolutionIds.add(resolution.resolution.id);
    messages.push(
      getAgentMessage(resolution, resolution.resolution.id !== options.latestResolutionId),
    );
  } else if (shouldShowAgentTyping(options.comment, options.isAgentAnswering)) {
    messages.push({
      createdAt: new Date().toISOString(),
      node: renderAgentTyping(options.comment.id),
    });
  }

  return messages;
}

function getUserCommentMessage(comment: ReviewComment): ConversationMessage {
  return {
    createdAt: comment.createdAt,
    node: renderConversationMessage({
      body: comment.body,
      key: comment.id,
      meta: formatUserMeta(comment),
      speaker: "user",
    }),
  };
}

function formatUserMeta(comment: ReviewComment): string {
  const status = comment.status === "submitted" ? "submitted" : undefined;

  return ["You", formatDateTime(comment.createdAt), status].filter(Boolean).join(" · ");
}

function getAgentMessage(item: ThreadResolution, isEarlier: boolean): ConversationMessage {
  const text = item.body ?? item.resolution.summary;

  return {
    createdAt: item.resolution.createdAt,
    node: renderConversationMessage({
      body: text,
      footer:
        item.resolution.beforeAfter === undefined ? undefined : (
          <div className="mt-2">
            <div className="mb-1 text-xs font-medium text-emerald-800">Changed diff</div>
            <ConversationDiffSnippet diff={item.resolution.beforeAfter} />
          </div>
        ),
      key: item.resolution.id,
      isEarlier,
      meta: formatAgentMeta(item.resolution, isEarlier),
      speaker: "agent",
    }),
  };
}

function formatAgentMeta(resolution: ReviewResolution, isEarlier: boolean): string {
  return ["Agent", formatDateTime(resolution.createdAt), isEarlier ? "earlier" : undefined]
    .filter(Boolean)
    .join(" · ");
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

type ConversationBubbleOptions = {
  body: string;
  footer?: ReactNode;
  isEarlier?: boolean;
  key: string;
  meta: string;
  speaker: ConversationSpeaker;
};

function renderConversationMessage(options: ConversationBubbleOptions): ReactNode {
  return <ConversationMessageBubble {...options} />;
}

function getLatestResolutionId(resolutions: ThreadResolution[]): string | undefined {
  return [...resolutions]
    .sort((left, right) => left.resolution.createdAt.localeCompare(right.resolution.createdAt))
    .at(-1)?.resolution.id;
}

function shouldShowAgentTyping(comment: ReviewComment, isAgentAnswering: boolean): boolean {
  return isAgentAnswering && comment.status === "submitted";
}

function renderAgentTyping(commentId: string): ReactNode {
  return (
    <div className="flex justify-start" key={`${commentId}-agent-typing`}>
      <div className="max-w-[78%] rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-950 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
          Agent is answering
        </div>
        <div className="mt-2 flex items-center gap-1 text-xs text-emerald-700">
          <span className="typing-dot" />
          <span className="typing-dot animation-delay-150" />
          <span className="typing-dot animation-delay-300" />
        </div>
      </div>
    </div>
  );
}
