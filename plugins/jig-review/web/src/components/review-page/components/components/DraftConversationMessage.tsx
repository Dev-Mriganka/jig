import { Button } from "@web/components/ui/index.js";
import type { DraftComment } from "@web/types.js";
import type { FC } from "react";
import { useState } from "react";

type DraftConversationMessageProps = {
  draft: DraftComment;
  onAskDraft: (draft: DraftComment) => Promise<void>;
  onRemoveDraft: (draftId: string) => void;
  onUpdateDraft: (draft: DraftComment) => void;
};

/**
 * Renders a draft message inside its conversation thread with edit, ask, and remove actions.
 */
export const DraftConversationMessage: FC<DraftConversationMessageProps> = ({
  draft,
  onAskDraft,
  onRemoveDraft,
  onUpdateDraft,
  // eslint-disable-next-line max-lines-per-function -- Draft edit, ask, and remove behavior is one cohesive message interaction.
}) => {
  const [editedBody, setEditedBody] = useState(draft.body);
  const [isAsking, setIsAsking] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-blue-950 shadow-sm">
      <div className="text-xs font-medium text-blue-800">You · draft</div>
      {isEditing ? (
        <textarea
          className="mt-2 h-24 w-full rounded border border-blue-200 bg-white p-2 text-sm text-slate-950"
          onChange={(event) => {
            setEditedBody(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              saveEdit();
            }
          }}
          value={editedBody}
        />
      ) : (
        <p className="mt-1 whitespace-pre-wrap text-sm">{draft.body}</p>
      )}
      {isEditing ? (
        <div className="mt-2 flex justify-end gap-2">
          <Button
            className="px-2 py-1 text-xs"
            onClick={() => {
              saveEdit();
            }}
            variant="primary"
          >
            Save
          </Button>
          <Button
            className="px-2 py-1 text-xs"
            onClick={() => {
              cancelEdit();
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex justify-end gap-2">
          <Button
            className="px-2 py-1 text-xs"
            disabled={isAsking}
            onClick={() => {
              void askDraft();
            }}
            title="Ask the agent now and remove this item from drafts."
            variant="link"
          >
            {isAsking ? "Asking…" : "Ask"}
          </Button>
          <Button
            className="px-2 py-1 text-xs"
            onClick={() => {
              setIsEditing(true);
            }}
          >
            Edit
          </Button>
          <Button
            className="px-2 py-1 text-xs"
            onClick={() => {
              onRemoveDraft(draft.id);
            }}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );

  function saveEdit(): void {
    const body = editedBody.trim();

    if (body.length === 0) {
      return;
    }

    onUpdateDraft({ ...draft, body });
    setIsEditing(false);
  }

  function cancelEdit(): void {
    setEditedBody(draft.body);
    setIsEditing(false);
  }

  async function askDraft(): Promise<void> {
    setIsAsking(true);

    try {
      await onAskDraft(draft);
    } finally {
      setIsAsking(false);
    }
  }
};
