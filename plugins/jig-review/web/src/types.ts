import type {
  ApprovalMethod,
  PasskeySummary,
  ReviewApproval,
  ReviewComment,
  ReviewIteration,
  ReviewRecord,
  ReviewResolution,
  ReviewResolutionLocation,
  ReviewSettings,
} from "../../src/types.js";

export type {
  ApprovalMethod,
  PasskeySummary,
  ReviewApproval,
  ReviewComment,
  ReviewIteration,
  ReviewRecord,
  ReviewResolution,
  ReviewResolutionLocation,
  ReviewSettings,
};

export type DraftComment = {
  id: string;
  body: string;
  filePath?: string;
  line?: number;
  side?: "old" | "new";
};

export type ReviewPayload = {
  isActive: boolean;
  review: ReviewRecord;
  settings: ReviewSettings;
};

export type ReviewDetailPayload = {
  isActive: boolean;
  review: ReviewRecord;
  settings: ReviewSettings;
};

export type ReviewListPayload = {
  activeReviewId?: string;
  reviews: ReviewRecord[];
};

/** What `/api/passkeys` lists: the registered keys by fingerprint, and anything wrong with the store. */
export type PasskeyListPayload = {
  passkeys: PasskeySummary[];
  problems: string[];
  problem?: string;
};

/** How the server says the page can approve now. */
export type ApprovalOptionsPayload =
  | { method: "passkey"; publicKey: PublicKeyRequestJSON }
  | { method: "none"; canRegister: boolean; problem?: string };

/** The server's options for `navigator.credentials.get`, with binary fields as base64url text. */
export type PublicKeyRequestJSON = {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: "required";
  allowCredentials: Array<{ type: "public-key"; id: string }>;
};

/** The server's options for `navigator.credentials.create`, with binary fields as base64url text. */
export type PublicKeyCreationJSON = {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout: number;
  attestation: "none";
  authenticatorSelection: { userVerification: "required"; residentKey: "discouraged" };
  excludeCredentials: Array<{ type: "public-key"; id: string }>;
};

/** What an approval attempt came to. */
export type ApprovalOutcome = { ok: true; method: ApprovalMethod } | { ok: false; message: string };
