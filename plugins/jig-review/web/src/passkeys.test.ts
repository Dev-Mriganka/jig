import { describe, expect, it } from "vitest";

import { base64UrlToBytes, bytesToBase64Url, toCreationOptions, toRequestOptions } from "./passkeys.js";

describe("base64url", () => {
  it("round-trips every byte value, without padding or the + and / characters", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const text = bytesToBase64Url(bytes);

    expect(text).not.toMatch(/[+/=]/);
    expect([...base64UrlToBytes(text)]).toEqual([...bytes]);
  });

  it("matches the encoding the server uses", () => {
    expect(bytesToBase64Url(Uint8Array.from([251, 255]))).toBe("-_8");
    expect([...base64UrlToBytes("-_8")]).toEqual([251, 255]);
    expect(bytesToBase64Url(new ArrayBuffer(0))).toBe("");
  });
});

describe("the server's options become the browser's", () => {
  it("decodes the challenge, the user handle and the excluded credentials for create", () => {
    const options = toCreationOptions({
      rp: { id: "localhost", name: "Jig code review" },
      user: { id: "AQID", name: "reviewer", displayName: "Reviewer" },
      challenge: "BAUG",
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 120000,
      attestation: "none",
      authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
      excludeCredentials: [{ type: "public-key", id: "BwgJ" }],
    });

    expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([4, 5, 6]);
    expect([...new Uint8Array(options.user.id as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(options.excludeCredentials?.[0]?.id as ArrayBuffer)]).toEqual([7, 8, 9]);
    expect(options.rp.id).toBe("localhost");
    expect(options.attestation).toBe("none");
    expect(options.authenticatorSelection?.userVerification).toBe("required");
  });

  it("decodes the challenge and the allowed credentials for get, and keeps user verification required", () => {
    const options = toRequestOptions({
      challenge: "BAUG",
      rpId: "localhost",
      timeout: 120000,
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: "BwgJ" }],
    });

    expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([4, 5, 6]);
    expect([...new Uint8Array(options.allowCredentials?.[0]?.id as ArrayBuffer)]).toEqual([7, 8, 9]);
    expect(options.rpId).toBe("localhost");
    expect(options.userVerification).toBe("required");
  });
});
