import { Button } from "@web/components/ui/index.js";
import type { DraftComment } from "@web/types.js";
import type { FC, KeyboardEvent, ReactNode } from "react";
import { useEffect, useState } from "react";

import { registerActiveComposer } from "./composerSwitch.js";

type InlineCommentFormProps = {
  autoFocus?: boolean;
  filePath: string;
  line: number;
  onAsk?: (comment: DraftComment) => Promise<void>;
  onCancel?: () => void;
  onSubmit: (comment: DraftComment) => void;
  side: "old" | "new";
  switchKey?: string;
};

/**
 * Renders an inline GitHub-style comment form under the selected diff line.
 */
export const InlineCommentForm: FC<InlineCommentFormProps> = ({
  autoFocus = true,
  filePath,
  line,
  onAsk,
  onCancel,
  onSubmit,
  side,
  switchKey,
}) => {
  const { ask, body, clearAndClose, handleKeyDown, isAsking, setBody, submit } =
    useInlineCommentActions({
      filePath,
      line,
      onAsk,
      onCancel,
      onSubmit,
      side,
      switchKey,
    });

  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 p-3 shadow-sm">
      <div className="mb-2 text-xs font-medium text-slate-600">
        Comment on {filePath}:{line.toString()} ({side})
      </div>
      <textarea
        autoFocus={autoFocus}
        className="h-24 w-full rounded-md border border-slate-300 bg-white p-2 text-sm"
        onChange={(event) => {
          setBody(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Leave a comment"
        value={body}
      />
      {renderActions({ ask, clearAndClose, isAsking, onAsk, onCancel, submit })}
    </div>
  );
};

type InlineCommentActions = {
  ask: () => Promise<void>;
  body: string;
  clearAndClose: () => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  isAsking: boolean;
  setBody: (body: string) => void;
  submit: () => void;
};

type InlineCommentActionOptions = Pick<
  InlineCommentFormProps,
  "filePath" | "line" | "onAsk" | "onCancel" | "onSubmit" | "side" | "switchKey"
>;

function useInlineCommentActions(options: InlineCommentActionOptions): InlineCommentActions {
  const [body, setBody] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const createComment = (): DraftComment | undefined => createDraftComment(options, body);

  const clearAndClose = (): void => {
    setBody("");
    options.onCancel?.();
  };

  const submit = (): void => {
    submitComment({ createComment, onSubmit: options.onSubmit, setBody });
  };

  const ask = async (): Promise<void> => {
    await askComment({ createComment, onAsk: options.onAsk, setBody, setIsAsking });
  };

  useEffect(() => {
    if (options.switchKey === undefined) {
      return undefined;
    }

    return registerActiveComposer({
      addComment: submit,
      discard: clearAndClose,
      hasContent: () => body.trim().length > 0,
      id: options.switchKey,
    });
  }, [body, clearAndClose, options.switchKey, submit]);

  return {
    ask,
    body,
    clearAndClose,
    handleKeyDown: (event): void => {
      handleMessageKeyDown(event, { ask, clearAndClose, submit });
    },
    isAsking,
    setBody,
    submit,
  };
}

type ActionOptions = Pick<InlineCommentFormProps, "onAsk" | "onCancel"> & {
  ask: () => Promise<void>;
  clearAndClose: () => void;
  isAsking: boolean;
  submit: () => void;
};

function renderActions(options: ActionOptions): ReactNode {
  return (
    <div className="mt-2 flex justify-end gap-2">
      {options.onCancel === undefined ? undefined : (
        <Button className="px-3 py-1 text-sm" onClick={options.clearAndClose}>
          Cancel
        </Button>
      )}
      {options.onAsk === undefined ? undefined : renderAskButton(options)}
      <Button className="px-3 py-1 text-sm" onClick={options.submit} variant="primary">
        Add comment
      </Button>
    </div>
  );
}

function renderAskButton(options: ActionOptions): ReactNode {
  return (
    <Button
      className="px-3 py-1 text-sm"
      disabled={options.isAsking}
      onClick={() => {
        void options.ask();
      }}
      title="Ask the agent now without submitting the whole review. The agent can answer or change code immediately."
      variant="link"
    >
      {options.isAsking ? "Asking…" : "Ask"}
    </Button>
  );
}

type KeyboardActionOptions = {
  ask: () => Promise<void>;
  clearAndClose: () => void;
  submit: () => void;
};

function handleMessageKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  options: KeyboardActionOptions,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    options.clearAndClose();

    return;
  }

  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();

  if (event.shiftKey) {
    void options.ask();
  } else {
    options.submit();
  }
}

type SubmitCommentOptions = {
  createComment: () => DraftComment | undefined;
  onSubmit: (comment: DraftComment) => void;
  setBody: (body: string) => void;
};

function submitComment({ createComment, onSubmit, setBody }: SubmitCommentOptions): void {
  const comment = createComment();

  if (comment === undefined) {
    return;
  }

  onSubmit(comment);
  setBody("");
}

type AskCommentOptions = {
  createComment: () => DraftComment | undefined;
  onAsk?: (comment: DraftComment) => Promise<void>;
  setBody: (body: string) => void;
  setIsAsking: (isAsking: boolean) => void;
};

async function askComment({
  createComment,
  onAsk,
  setBody,
  setIsAsking,
}: AskCommentOptions): Promise<void> {
  const comment = createComment();

  if (comment === undefined || onAsk === undefined) {
    return;
  }

  setIsAsking(true);

  try {
    await onAsk(comment);
    setBody("");
  } finally {
    setIsAsking(false);
  }
}

function createDraftComment(
  options: InlineCommentActionOptions,
  body: string,
): DraftComment | undefined {
  const trimmedBody = body.trim();

  if (trimmedBody.length === 0) {
    return undefined;
  }

  return {
    id: crypto.randomUUID(),
    body: trimmedBody,
    filePath: options.filePath,
    line: options.line,
    side: options.side,
  };
}
