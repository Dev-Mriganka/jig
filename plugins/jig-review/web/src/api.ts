import { createPasskey, signWithPasskey } from "./passkeys.js";
import type {
  ApprovalOptionsPayload,
  ApprovalOutcome,
  DraftComment,
  PasskeyListPayload,
  PasskeySummary,
  PublicKeyCreationJSON,
  ReviewDetailPayload,
  ReviewListPayload,
  ReviewPayload,
  ReviewSettings,
} from "./types.js";

/** The page and the API are one origin: the server sets the session cookie for it, and its Host and Origin checks need it. */
function getApiUrl(path: string): string {
  return path;
}

/**
 * The URL of a local review API route.
 *
 * @param path API route path beginning with `/`.
 * @returns The path, which the browser resolves against the page's own origin.
 */
export function getReviewApiUrl(path: string): string {
  return getApiUrl(path);
}

/**
 * Fetches the current review payload and project review settings from the local server.
 *
 * @returns Active review payload consumed by the browser UI.
 */
export async function fetchReview(): Promise<ReviewPayload> {
  const response = await fetch(getApiUrl("/api/review"));

  if (!response.ok) {
    throw new Error("Unable to load review.");
  }

  return (await response.json()) as ReviewPayload;
}

/**
 * Fetches all persisted review records for review-list navigation.
 *
 * @returns Reviews ordered for browser navigation.
 */
export async function fetchReviews(): Promise<ReviewListPayload> {
  const response = await fetch(getApiUrl("/api/reviews"));

  if (!response.ok) {
    throw new Error("Unable to load reviews.");
  }

  return (await response.json()) as ReviewListPayload;
}

/**
 * Fetches one persisted review record by id.
 *
 * @param id Review id from the review list.
 * @returns Review detail payload.
 */
export async function fetchReviewById(id: string): Promise<ReviewDetailPayload> {
  const response = await fetch(getApiUrl(`/api/reviews/${encodeURIComponent(id)}`));

  if (!response.ok) {
    throw new Error("Unable to load review.");
  }

  return (await response.json()) as ReviewDetailPayload;
}

/**
 * Submits drafted browser comments to the extension server for agent follow-up.
 *
 * @param comments Line and general comments collected in the review UI.
 */
export async function submitComments(comments: DraftComment[]): Promise<void> {
  await postComments("/api/comments", comments);
}

/**
 * Sends one comment to the agent immediately without submitting the whole review batch.
 *
 * @param comment Comment or question to ask the agent about immediately.
 */
export async function askAgent(comment: DraftComment): Promise<void> {
  await postComments("/api/ask", [comment]);
}

async function postComments(path: string, comments: DraftComment[]): Promise<void> {
  const response = await fetch(getApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      comments: comments.map((comment) => ({
        body: comment.body,
        filePath: comment.filePath,
        line: comment.line,
        side: comment.side,
      })),
    }),
  });

  if (!response.ok) {
    throw new Error("Unable to submit comments.");
  }
}

/**
 * Persists project review settings changed from the browser UI.
 *
 * @param settings Partial settings update to save server-side.
 */
export async function updateReviewSettings(settings: Partial<ReviewSettings>): Promise<void> {
  const response = await fetch(getApiUrl("/api/settings"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });

  if (!response.ok) {
    throw new Error("Unable to update review settings.");
  }
}

/** Fetches the saved review settings. */
export async function fetchSettings(): Promise<ReviewSettings> {
  const response = await fetch(getApiUrl("/api/settings"));

  if (!response.ok) {
    throw new Error("Unable to load settings.");
  }

  return (await response.json()) as ReviewSettings;
}

/** The server's one-line reason for a refusal, else `fallback`. */
async function readError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    const reason = typeof body.error === "string" ? body.error : body.message;

    return new Error(typeof reason === "string" ? reason : fallback);
  } catch {
    return new Error(fallback);
  }
}

async function postJson<T>(path: string, body: unknown, fallback: string): Promise<T> {
  const response = await fetch(getApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    throw await readError(response, fallback);
  }

  return (await response.json()) as T;
}

/** Asks the server how this review can be approved now: with a registered passkey, or not yet. */
export function fetchApprovalOptions(): Promise<ApprovalOptionsPayload> {
  return postJson("/api/approve/options", undefined, "Unable to start the approval.");
}

/**
 * Approves with a passkey: the server's challenge is signed by the device (Windows Hello, Touch ID or a security key) and
 * the server checks the signature. Nothing the page does can approve without it.
 */
export async function approveWithPasskey(options: Extract<ApprovalOptionsPayload, { method: "passkey" }>): Promise<ApprovalOutcome> {
  const assertion = await signWithPasskey(options.publicKey);

  return postJson("/api/approve/passkey", assertion, "The approval was not accepted.");
}

/**
 * The fallback: marks the review approved in the page, then waits while Pi asks the user. It approves only when the user
 * answers y in Pi.
 */
export function approveInPi(): Promise<ApprovalOutcome> {
  return postJson("/api/approve/page", undefined, "Unable to ask Pi.");
}

/** Makes a passkey on this device and registers it. The user must confirm its fingerprint in Pi before it is stored. */
export async function registerPasskey(): Promise<PasskeySummary> {
  const { publicKey } = await postJson<{ publicKey: PublicKeyCreationJSON }>("/api/passkeys/options", undefined, "Unable to start the registration.");
  const credential = await createPasskey(publicKey);
  const registered = await postJson<{ passkey: PasskeySummary }>("/api/passkeys", credential, "The passkey was not registered.");

  return registered.passkey;
}

/** The registered passkeys, by fingerprint. */
export async function fetchPasskeys(): Promise<PasskeyListPayload> {
  const response = await fetch(getApiUrl("/api/passkeys"));

  if (!response.ok) {
    throw await readError(response, "Unable to load passkeys.");
  }

  return (await response.json()) as PasskeyListPayload;
}

/** Asks to remove a passkey. The user must confirm in Pi; `ok` is false when they declined there. */
export async function removePasskey(fingerprint: string): Promise<ApprovalOutcome> {
  const response = await fetch(getApiUrl(`/api/passkeys/${encodeURIComponent(fingerprint)}`), { method: "DELETE" });

  if (!response.ok && response.status !== 409) {
    throw await readError(response, "Unable to remove the passkey.");
  }

  return (await response.json()) as ApprovalOutcome;
}
