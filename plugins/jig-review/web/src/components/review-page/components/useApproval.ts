import { approveInPi, approveWithPasskey, fetchApprovalOptions, registerPasskey } from "@web/api.js";
import { describePasskeyError, supportsPasskeys } from "@web/passkeys.js";
import type { ApprovalMethod } from "@web/types.js";
import { useState } from "react";

/**
 * Where an approval is. A passkey approves by itself; without one, the user registers one (Pi shows its fingerprint and asks
 * them to confirm it) or approves in Pi instead.
 */
export type ApprovalState =
  | { step: "idle" }
  | { step: "working"; message: string }
  | { step: "choose"; canRegister: boolean; hasBrowserSupport: boolean; problem?: string }
  | { step: "failed"; message: string; canTryAgain: boolean }
  | { step: "done"; method: ApprovalMethod };

type Approval = {
  approve: () => Promise<void>;
  approveElsewhere: () => Promise<void>;
  register: () => Promise<void>;
  reset: () => void;
  state: ApprovalState;
};

/**
 * Drives the Approve button: asks the server how the review can be approved, then runs the passkey prompt or the fallback.
 *
 * @param onApproved Called once the server has approved the review.
 */
export function useApproval(onApproved: (method: ApprovalMethod) => Promise<void>): Approval {
  const [state, setState] = useState<ApprovalState>({ step: "idle" });

  const finish = async (method: ApprovalMethod): Promise<void> => {
    setState({ step: "done", method });
    await onApproved(method);
  };

  const withPasskey = async (): Promise<void> => {
    const options = await fetchApprovalOptions();

    if (options.method === "none") {
      setState({ step: "choose", canRegister: options.canRegister, hasBrowserSupport: supportsPasskeys(), problem: options.problem });

      return;
    }

    setState({ step: "working", message: "Use your passkey (Windows Hello, Touch ID or a security key) to approve." });
    const outcome = await approveWithPasskey(options);

    if (outcome.ok) {
      await finish(outcome.method);
    } else {
      setState({ step: "failed", message: outcome.message, canTryAgain: true });
    }
  };

  const run = async (action: () => Promise<void>, canTryAgain = true): Promise<void> => {
    try {
      await action();
    } catch (error) {
      setState({ step: "failed", message: describePasskeyError(error), canTryAgain });
    }
  };

  return {
    approve: () => run(withPasskey),
    approveElsewhere: () =>
      run(async () => {
        setState({ step: "working", message: "Waiting for your answer in Pi: y approves, n declines." });
        const outcome = await approveInPi();

        if (outcome.ok) {
          await finish(outcome.method);
        } else {
          setState({ step: "failed", message: outcome.message, canTryAgain: true });
        }
      }),
    register: () =>
      run(async () => {
        setState({ step: "working", message: "Create the passkey in the prompt, then confirm its fingerprint in Pi." });
        await registerPasskey();
        await withPasskey();
      }),
    reset: () => {
      setState({ step: "idle" });
    },
    state,
  };
}
