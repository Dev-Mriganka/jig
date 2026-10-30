import { describe, expect, it } from "vitest";

import { formatFingerprint } from "./SettingsPage.js";

describe("formatFingerprint", () => {
  it("groups the SHA-256 digits by eight, as Pi shows them", () => {
    expect(formatFingerprint("0123456789abcdef".repeat(4))).toBe("01234567 89abcdef 01234567 89abcdef 01234567 89abcdef 01234567 89abcdef");
  });
});
