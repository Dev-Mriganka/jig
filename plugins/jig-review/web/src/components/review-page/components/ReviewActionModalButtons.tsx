import { Button } from "@web/components/ui/index.js";
import type { DraftComment, ReviewRecord } from "@web/types.js";
import type { FC } from "react";

type ReviewActionModalButtonsProps = {
  drafts: DraftComment[];
  generalComment: string;
  onApprove: () => Promise<void>;
  onClose: () => void;
  onSubmitReview: () => Promise<void>;
  review: ReviewRecord;
};

/**
 * Renders footer actions for approving or submitting the modal review.
 */
export const ReviewActionModalButtons: FC<ReviewActionModalButtonsProps> = ({
  drafts,
  generalComment,
  onApprove,
  onClose,
  onSubmitReview,
  review,
}) => (
  <div className="mt-5 flex justify-end gap-3">
    <Button className="px-4 py-2" onClick={onClose}>
      Keep reviewing
    </Button>
    <Button
      className="px-4 py-2"
      disabled={review.status === "approved" || review.status === "awaiting-agent"}
      onClick={() => void onApprove()}
      title="Approve with your passkey, or in Pi if you have none"
      variant="success"
    >
      Approve
    </Button>
    <Button
      className="px-4 py-2"
      disabled={
        review.status === "approved" ||
        review.status === "awaiting-agent" ||
        getSubmittedComments(drafts, generalComment).length === 0
      }
      onClick={() => void onSubmitReview()}
      variant="primary"
    >
      Submit comments
    </Button>
  </div>
);

export function getSubmittedComments(
  drafts: DraftComment[],
  generalComment: string,
): DraftComment[] {
  const trimmedGeneralComment = generalComment.trim();

  return trimmedGeneralComment.length > 0
    ? [...drafts, { id: crypto.randomUUID(), body: trimmedGeneralComment }]
    : drafts;
}
