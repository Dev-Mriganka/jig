import type { ReviewApproval, ReviewRecord } from "@web/types.js";
import type { FC } from "react";

type ReviewStatusBadgeProps = {
  approval?: ReviewApproval;
  isActive?: boolean;
  status: ReviewRecord["status"];
};

/**
 * Displays review status consistently across list and detail pages.
 */
export const ReviewStatusBadge: FC<ReviewStatusBadgeProps> = ({ approval, isActive = false, status }) => (
  <span className={getStatusClassName(status, isActive)}>{isActive ? "active" : getLabel(status, approval)}</span>
);

function getLabel(status: ReviewRecord["status"], approval: ReviewApproval | undefined): string {
  if (status !== "approved" || approval === undefined) {
    return status;
  }

  return approval.method === "passkey" ? "approved · passkey" : "approved · page and Pi";
}

function getStatusClassName(status: ReviewRecord["status"], isActive: boolean): string {
  const baseClassName = "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold";

  if (isActive) {
    return `${baseClassName} bg-blue-100 text-blue-800`;
  }

  if (status === "approved") {
    return `${baseClassName} bg-emerald-100 text-emerald-800`;
  }

  if (status === "abandoned") {
    return `${baseClassName} bg-slate-200 text-slate-700`;
  }

  if (status === "awaiting-agent") {
    return `${baseClassName} bg-purple-100 text-purple-800`;
  }

  return `${baseClassName} bg-amber-100 text-amber-800`;
}
