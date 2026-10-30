import type { FC, ReactNode } from "react";

export type ConversationSpeaker = "agent" | "system" | "user";

type ConversationMessageBubbleProps = {
  body: string;
  footer?: ReactNode;
  isEarlier?: boolean;
  meta: string;
  speaker: ConversationSpeaker;
  title?: string;
};

/**
 * Renders a shared conversation message bubble for inline threads and review activity pages.
 */
export const ConversationMessageBubble: FC<ConversationMessageBubbleProps> = ({
  body,
  footer,
  isEarlier = false,
  meta,
  speaker,
  title,
}) => {
  const metaClassName = getMetaClassName(speaker);

  return (
    <div
      className={`rounded-lg border px-3 py-2 shadow-sm ${getBubbleClassName(speaker, isEarlier)}`}
    >
      <div className={`text-xs font-medium ${metaClassName}`}>{meta}</div>
      {title === undefined ? undefined : <div className="mt-1 text-sm font-medium">{title}</div>}
      {isEarlier ? (
        <p className="mt-1 text-xs text-slate-500">
          Earlier agent response. It may refer to a previous version of this line.
        </p>
      ) : undefined}
      <p className="mt-1 whitespace-pre-wrap text-sm">{body}</p>
      {footer}
    </div>
  );
};

function getMetaClassName(speaker: ConversationSpeaker): string {
  switch (speaker) {
    case "agent":
      return "text-emerald-800";
    case "system":
      return "text-slate-600";
    case "user":
      return "text-blue-800";
  }
}

function getBubbleClassName(speaker: ConversationSpeaker, isEarlier: boolean): string {
  if (speaker === "user") {
    return "border-blue-200 bg-blue-50 text-blue-950";
  }

  if (speaker === "system") {
    return "border-slate-200 bg-white text-slate-800";
  }

  return isEarlier
    ? "border-slate-200 bg-slate-50 text-slate-700 opacity-80"
    : "border-emerald-200 bg-emerald-50 text-emerald-950";
}
