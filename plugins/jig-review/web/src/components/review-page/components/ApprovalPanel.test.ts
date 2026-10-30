import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalPanel } from "./ApprovalPanel.js";
import type { ApprovalState } from "./useApproval.js";

const noop = (): void => undefined;

function render(state: ApprovalState): string {
  return renderToStaticMarkup(createElement(ApprovalPanel, { onApprove: noop, onApproveInPi: noop, onRegister: noop, onReset: noop, state }));
}

describe("ApprovalPanel", () => {
  it("shows nothing before an approval starts", () => {
    expect(render({ step: "idle" })).toBe("");
  });

  it("says what it is waiting for", () => {
    expect(render({ step: "working", message: "Waiting for your answer in Pi: y approves, n declines." })).toContain("Waiting for your answer in Pi");
  });

  it("offers to register a passkey or approve in Pi when none is registered, and says the fallback needs a y", () => {
    const html = render({ step: "choose", canRegister: true, hasBrowserSupport: true });

    expect(html).toContain("No passkey is registered on this machine.");
    expect(html).toContain("Register a passkey and approve");
    expect(html).toContain("Approve in Pi instead");
    expect(html).toContain("only after y");
  });

  it("does not offer to register when the store cannot be written or the browser has no passkeys", () => {
    const broken = render({ step: "choose", canRegister: false, hasBrowserSupport: true, problem: "passkeys.json is not valid JSON" });

    expect(broken).not.toContain("Register a passkey and approve");
    expect(broken).toContain("passkeys.json is not valid JSON");
    expect(broken).toContain("Approve in Pi instead");

    const unsupported = render({ step: "choose", canRegister: true, hasBrowserSupport: false });

    expect(unsupported).not.toContain("Register a passkey and approve");
    expect(unsupported).toContain("This browser has no passkey support.");
  });

  it("shows why an approval failed, with a way to try again", () => {
    const html = render({ step: "failed", message: "Not accepted: the signature does not match the registered key.", canTryAgain: true });

    expect(html).toContain("the signature does not match");
    expect(html).toContain("Try again");
  });

  it("says how a finished approval was given", () => {
    expect(render({ step: "done", method: "passkey" })).toContain("with your passkey");
    expect(render({ step: "done", method: "page-and-pi" })).toContain("in the page and then in Pi");
  });
});
