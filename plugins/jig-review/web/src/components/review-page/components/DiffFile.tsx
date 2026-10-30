import {
  buildReviewThreads,
  getSelectedLine,
  type SelectedLine,
} from "@web/discussions/buildReviewThreads.js";
import type { ReviewThread, ReviewThreadMap } from "@web/discussions/types.js";
import { getReviewFilePath, type ReviewFile } from "@web/review-file.js";
import type { DraftComment, ReviewRecord, ReviewSettings } from "@web/types.js";
import type { FC, MouseEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import type { RenderGutter } from "react-diff-view";
import { Diff, Hunk, isDelete } from "react-diff-view";

import { resolveActiveComposerBeforeSwitch } from "./composerSwitch.js";
import { getTokens, isCollapsedByDefault } from "./diffFileHelpers.js";
import { InlineCommentForm } from "./InlineCommentForm.js";
import { InlineThread } from "./InlineThread.js";
import { getFileAnchorId } from "./reviewMetrics.js";

type DiffFileProps = {
  drafts: DraftComment[];
  file: ReviewFile;
  onAddDraft: (comment: DraftComment) => void;
  onAskDraft: (comment: DraftComment) => Promise<void>;
  onRemoveDraft: (draftId: string) => void;
  onUpdateDraft: (draft: DraftComment) => void;
  review: ReviewRecord;
  viewType: ReviewSettings["diffView"];
};

/**
 * Renders one changed file with syntax highlighting and GitHub-style inline commenting.
 */
export const DiffFile: FC<DiffFileProps> = ({
  drafts,
  file,
  onAddDraft,
  onAskDraft,
  onRemoveDraft,
  onUpdateDraft,
  review,
  viewType,
}) => {
  const filePath = getReviewFilePath(file);
  const anchorId = getFileAnchorId(file);
  const [selectedLine, setSelectedLine] = useState<SelectedLine>();
  const [isCollapsed, setIsCollapsed] = useState(isCollapsedByDefault(filePath));
  const threads = useMemo(
    () => buildReviewThreads({ activeReview: review, drafts, file }),
    [drafts, file, review],
  );
  const tokens = useMemo(() => getTokens(file), [file]);

  return (
    <article className="scroll-mt-24 rounded-lg bg-white shadow" id={anchorId}>
      {renderFileHeader(filePath, isCollapsed, () => {
        setIsCollapsed((current) => !current);
      })}
      {isCollapsed ? undefined : (
        <div className="overflow-x-auto text-sm">
          <Diff
            codeEvents={{
              onClick: ({ change, side }) => {
                selectLine({ change, filePath, setSelectedLine, side });
              },
            }}
            diffType={file.type}
            gutterEvents={{
              onClick: ({ change, side }) => {
                selectLine({ change, filePath, setSelectedLine, side });
              },
            }}
            hunks={file.hunks}
            renderGutter={renderGutter}
            tokens={tokens}
            viewType={viewType}
            widgets={getWidgets({
              onAddDraft,
              onAskDraft,
              onRemoveDraft,
              onUpdateDraft,
              selectedLine,
              setSelectedLine,
              threads,
            })}
          >
            {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
          </Diff>
        </div>
      )}
    </article>
  );
};

function renderFileHeader(filePath: string, isCollapsed: boolean, onToggle: () => void): ReactNode {
  return (
    <button
      className="sticky top-20 z-20 flex w-full items-center justify-between border-b border-slate-200 bg-white px-4 py-3 text-left font-mono text-sm font-semibold shadow-sm"
      onClick={onToggle}
      type="button"
    >
      <span>{filePath}</span>
      <span className="font-sans text-xs text-slate-500">
        {isCollapsed ? "Expand" : "Collapse"}
      </span>
    </button>
  );
}

type SelectLineOptions = {
  change: Parameters<typeof getSelectedLine>[0];
  filePath: string;
  setSelectedLine: (line: SelectedLine | undefined) => void;
  side: Parameters<typeof getSelectedLine>[1];
};

function selectLine({ change, filePath, setSelectedLine, side }: SelectLineOptions): void {
  const line = getSelectedLine(change, side, filePath);

  if (line === undefined) {
    return;
  }

  resolveActiveComposerBeforeSwitch(line.changeKey);
  setSelectedLine(line);
}

type WidgetOptions = {
  onAddDraft: (comment: DraftComment) => void;
  onAskDraft: (comment: DraftComment) => Promise<void>;
  onRemoveDraft: (draftId: string) => void;
  onUpdateDraft: (draft: DraftComment) => void;
  selectedLine: SelectedLine | undefined;
  setSelectedLine: (line: SelectedLine | undefined) => void;
  threads: ReviewThreadMap;
};

function getWidgets(options: WidgetOptions): Record<string, ReactNode> {
  const widgets = Object.fromEntries(
    [...options.threads.entries()].map(([changeKey, thread]) => [
      changeKey,
      getThreadWidget(thread, options),
    ]),
  );

  if (options.selectedLine !== undefined && widgets[options.selectedLine.changeKey] === undefined) {
    widgets[options.selectedLine.changeKey] = getSelectedLineWidget(options);
  }

  return widgets;
}

function getThreadWidget(thread: ReviewThread, options: WidgetOptions): ReactNode {
  return (
    <InlineThread
      key={`${thread.filePath}:${thread.line.toString()}:${thread.side}`}
      onAddDraft={options.onAddDraft}
      onAskDraft={options.onAskDraft}
      onRemoveDraft={options.onRemoveDraft}
      onUpdateDraft={options.onUpdateDraft}
      thread={thread}
    />
  );
}

function getSelectedLineWidget(options: WidgetOptions): ReactNode {
  const { onAddDraft, onAskDraft, selectedLine, setSelectedLine } = options;

  if (selectedLine === undefined) {
    return undefined;
  }

  return (
    <div className="space-y-3">
      <InlineCommentForm
        filePath={selectedLine.filePath}
        line={selectedLine.line}
        onCancel={() => {
          setSelectedLine(undefined);
        }}
        onAsk={async (comment) => {
          await onAskDraft(comment);
          setSelectedLine(undefined);
        }}
        onSubmit={(comment) => {
          onAddDraft(comment);
          setSelectedLine(undefined);
        }}
        side={selectedLine.side}
        switchKey={selectedLine.changeKey}
      />
    </div>
  );
}

const renderGutter: RenderGutter = ({
  change,
  inHoverState,
  renderDefault,
  side,
  wrapInAnchor,
}) => {
  const showCommentAction = side !== "old" || isDelete(change);

  return wrapInAnchor(
    <button
      className="diff-comment-gutter inline-flex w-full items-center justify-end gap-1"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
      }}
      type="button"
    >
      {showCommentAction ? (
        <span className="diff-comment-plus text-blue-600 opacity-0 transition-opacity">+</span>
      ) : undefined}
      <span>{renderDefault()}</span>
      {showCommentAction && inHoverState ? <span className="sr-only">Add comment</span> : undefined}
    </button>,
  );
};
