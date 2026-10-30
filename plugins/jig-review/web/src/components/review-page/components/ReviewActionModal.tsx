import { askAgent, submitComments } from "@web/api.js";
import { Button } from "@web/components/ui/index.js";
import type { ApprovalMethod, DraftComment, ReviewRecord } from "@web/types.js";
import type { FC, ReactNode } from "react";
import { useState } from "react";

import { ApprovalPanel } from "./ApprovalPanel.js";
import { DraftCommentList } from "./DraftCommentList.js";
import { getSubmittedComments, ReviewActionModalButtons } from "./ReviewActionModalButtons.js";
import { useApproval } from "./useApproval.js";

type ReviewActionModalProps = {
  drafts: DraftComment[];
  generalComment: string;
  isOpen: boolean;
  onClose: () => void;
  onDraftsChange: (drafts: DraftComment[]) => void;
  onGeneralCommentChange: (value: string) => void;
  onReload: () => Promise<void>;
  review: ReviewRecord;
};

/**
 * Collects final review actions in one dialog: approve, general note, or submit comments.
 */
export const ReviewActionModal: FC<ReviewActionModalProps> = (props) => {
  const { askGeneralComment, isAsking } = useGeneralCommentAsk(props);
  const approval = useApproval(async (method) => {
    await props.onReload();
    closeReviewPage(getApprovedMessage(method));
  });

  if (!props.isOpen) {
    return undefined;
  }

  const submitReview = async (): Promise<void> => {
    const comments = getSubmittedComments(props.drafts, props.generalComment);

    if (comments.length === 0) {
      return;
    }

    await submitComments(comments);
    props.onDraftsChange([]);
    props.onGeneralCommentChange("");
    await props.onReload();
    closeReviewPage("Review submitted. You can close this tab.");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
      <section className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-2xl">
        {renderModalHeader(props.onClose)}
        {renderReviewCommentField({
          isAsking,
          onAsk: askGeneralComment,
          onChange: props.onGeneralCommentChange,
          value: props.generalComment,
        })}
        <div className="mt-4">
          <h3 className="font-medium">Draft line comments</h3>
          <DraftCommentList drafts={props.drafts} />
        </div>
        <ReviewActionModalButtons
          drafts={props.drafts}
          generalComment={props.generalComment}
          onApprove={approval.approve}
          onClose={props.onClose}
          onSubmitReview={submitReview}
          review={props.review}
        />
        <ApprovalPanel
          onApprove={() => {
            void approval.approve();
          }}
          onApproveInPi={() => {
            void approval.approveElsewhere();
          }}
          onRegister={() => {
            void approval.register();
          }}
          onReset={approval.reset}
          state={approval.state}
        />
      </section>
    </div>
  );
};

type GeneralCommentAsk = {
  askGeneralComment: () => Promise<void>;
  isAsking: boolean;
};

function useGeneralCommentAsk(props: ReviewActionModalProps): GeneralCommentAsk {
  const [isAsking, setIsAsking] = useState(false);

  return {
    askGeneralComment: async (): Promise<void> => {
      const body = props.generalComment.trim();

      if (body.length === 0) {
        return;
      }

      setIsAsking(true);

      try {
        await askAgent({ id: crypto.randomUUID(), body });
        props.onGeneralCommentChange("");
        await props.onReload();
      } finally {
        setIsAsking(false);
      }
    },
    isAsking,
  };
}

function renderModalHeader(onClose: () => void): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold">Finish review</h2>
        <p className="mt-1 text-sm text-slate-600">
          Approve the changes, or submit your drafted line comments for the agent.
        </p>
      </div>
      <Button className="px-3 py-1 text-sm" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

type GeneralCommentFieldOptions = {
  isAsking: boolean;
  onAsk: () => Promise<void>;
  onChange: (value: string) => void;
  value: string;
};

function renderReviewCommentField(options: GeneralCommentFieldOptions): ReactNode {
  return (
    <>
      <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="general-comment">
        General comment
      </label>
      <textarea
        className="mt-2 h-28 w-full rounded-md border border-slate-300 p-2"
        id="general-comment"
        onChange={(event) => {
          options.onChange(event.target.value);
        }}
        placeholder="Optional whole-review comment"
        value={options.value}
      />
      <div className="mt-2 flex justify-end">
        <Button
          className="px-3 py-1 text-sm"
          disabled={options.isAsking}
          onClick={() => {
            void options.onAsk();
          }}
          title="Ask the agent now without submitting the whole review. The agent can answer or change code immediately."
          variant="link"
        >
          {options.isAsking ? "Asking…" : "Ask"}
        </Button>
      </div>
    </>
  );
}

function getApprovedMessage(method: ApprovalMethod): string {
  return method === "passkey"
    ? "Review approved with your passkey. You can close this tab."
    : "Review approved in the page and in Pi. You can close this tab.";
}

function closeReviewPage(message: string): void {
  window.close();
  window.setTimeout(() => {
    const main = document.createElement("main");

    main.setAttribute("style", "font-family: system-ui; padding: 2rem;");
    main.textContent = message;
    document.body.replaceChildren(main);
  }, 150);
}
