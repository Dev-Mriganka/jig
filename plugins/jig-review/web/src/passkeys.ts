import type { PublicKeyCreationJSON, PublicKeyRequestJSON } from "./types.js";

/**
 * The browser's side of WebAuthn. The server sends its options as JSON, with every binary value as base64url text; the
 * browser API wants buffers, and answers with buffers. These functions convert both ways and call the browser. They hold
 * no secret and make no decision: the server checks everything.
 */

/** Whether this browser can make and use passkeys at all. */
export function supportsPasskeys(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && typeof PublicKeyCredential !== "undefined" && navigator.credentials !== undefined;
}

export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";

  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** The options for `credentials.create`, with the binary fields decoded. */
export function toCreationOptions(options: PublicKeyCreationJSON): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: base64UrlToBytes(options.challenge),
    user: { ...options.user, id: base64UrlToBytes(options.user.id) },
    excludeCredentials: options.excludeCredentials.map((key) => ({ ...key, id: base64UrlToBytes(key.id) })),
  };
}

/** The options for `credentials.get`, with the binary fields decoded. */
export function toRequestOptions(options: PublicKeyRequestJSON): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: base64UrlToBytes(options.challenge),
    allowCredentials: options.allowCredentials.map((key) => ({ ...key, id: base64UrlToBytes(key.id) })),
  };
}

/** Asks the authenticator to make a passkey. Resolves to the JSON the server expects. */
export async function createPasskey(options: PublicKeyCreationJSON): Promise<unknown> {
  const credential = await navigator.credentials.create({ publicKey: toCreationOptions(options) });

  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("The browser did not make a passkey.");
  }

  return {
    id: bytesToBase64Url(credential.rawId),
    response: {
      clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
      attestationObject: bytesToBase64Url(credential.response.attestationObject),
    },
  };
}

/** Asks the authenticator to sign the server's challenge. Resolves to the JSON the server expects. */
export async function signWithPasskey(options: PublicKeyRequestJSON): Promise<unknown> {
  const credential = await navigator.credentials.get({ publicKey: toRequestOptions(options) });

  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("The browser did not sign.");
  }

  return {
    id: bytesToBase64Url(credential.rawId),
    response: {
      clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
      authenticatorData: bytesToBase64Url(credential.response.authenticatorData),
      signature: bytesToBase64Url(credential.response.signature),
    },
  };
}

/** A short reason for a failure of the browser's own passkey prompt, such as the user closing it. */
export function describePasskeyError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "The passkey prompt was closed or timed out.";
    }

    if (error.name === "InvalidStateError") {
      return "This device already has a passkey for the review page.";
    }
  }

  return error instanceof Error ? error.message : "The passkey prompt failed.";
}
