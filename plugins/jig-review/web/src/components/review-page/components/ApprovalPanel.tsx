import { Button } from "@web/components/ui/index.js";
import type { FC } from "react";

import type { ApprovalState } from "./useApproval.js";

type ApprovalPanelProps = {
  onApprove: () => void;
  onApproveInPi: () => void;
  onRegister: () => void;
  onReset: () => void;
  state: ApprovalState;
};

/**
 * Shows what the approval is waiting for: the passkey prompt, Pi's question, a choice when no passkey is registered, or why
 * it failed.
 */
export const ApprovalPanel: FC<ApprovalPanelProps> = ({ onApprove, onApproveInPi, onRegister, onReset, state }) => {
  if (state.step === "idle") {
    return undefined;
  }

  if (state.step === "working") {
    return (
      <p className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900" role="status">
        {state.message}
      </p>
    );
  }

  if (state.step === "done") {
    return (
      <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" role="status">
        Approved {state.method === "passkey" ? "with your passkey" : "in the page and then in Pi"}.
      </p>
    );
  }

  if (state.step === "failed") {
    return (
      <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
        <p>{state.message}</p>
        <div className="mt-2 flex gap-2">
          {state.canTryAgain ? (
            <Button className="px-3 py-1" onClick={onApprove}>
              Try again
            </Button>
          ) : undefined}
          <Button className="px-3 py-1" onClick={onReset} variant="link">
            Dismiss
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-medium">No passkey is registered on this machine.</p>
      <p className="mt-1">
        A passkey (Windows Hello or Touch ID) lets you approve here, and the agent cannot make your signature. Pi shows the key&apos;s
        fingerprint and asks you to confirm it before it is stored.
      </p>
      {state.problem === undefined ? undefined : <p className="mt-1 text-red-800">Cannot register: {state.problem}.</p>}
      {state.hasBrowserSupport ? undefined : <p className="mt-1 text-red-800">This browser has no passkey support.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {state.canRegister && state.hasBrowserSupport ? (
          <Button className="px-3 py-1.5" onClick={onRegister} variant="success">
            Register a passkey and approve
          </Button>
        ) : undefined}
        <Button className="px-3 py-1.5" onClick={onApproveInPi}>
          Approve in Pi instead
        </Button>
        <Button className="px-3 py-1.5" onClick={onReset} variant="link">
          Cancel
        </Button>
      </div>
      <p className="mt-2 text-xs text-amber-900">
        &quot;Approve in Pi instead&quot; marks the review approved in this page, and Pi then asks you y or n. It counts as approved only after y.
      </p>
    </div>
  );
};
