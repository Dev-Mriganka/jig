# Passkeys

How a review is approved in its page, and why the agent cannot do it. Back to the
[jig-review overview](../README.md).

## Why a passkey

[Approvals](../../../docs/approvals.md) say you approve inside the waiting call. A review is
different: it is long, it waits for you across many turns, and the page is where you read it.

A button in the page would be a web endpoint on this machine, and the agent's shell shares the
network with it. So the page cannot approve by being asked. It approves only when the server sees
something the agent cannot make: a signature from a key held by your device, made after your
device checked that you are there (a fingerprint, your face, a PIN).

That is WebAuthn, written on `node:crypto` alone, with no library.

## Registering

On the first Approve on a machine, with no passkey registered:

1. The page asks the server for options and calls `navigator.credentials.create`: relying party id
   `localhost`, user verification **required**, attestation `none`, algorithms ES256 and RS256.
2. The server checks the answer ([The checks](#the-checks)) and loads the public key from its COSE
   form.
3. **Before the key is stored, Pi asks you.** The question shows the key's SHA-256 fingerprint and
   asks you to answer `y` only if you made the key just now. The page waits, and shows that it is
   waiting.
4. After `y`, the key is added to the store. Registering a passkey approves nothing.

If you decline, nothing is stored and the page offers the fallback.

## Approving

1. Approve in the page asks the server for options. With a key registered, the server issues a fresh
   challenge: 32 random bytes, good for one answer and two minutes. The challenge is bound to the
   review and its diff as you were looking at it.
2. The page calls `navigator.credentials.get` with user verification required. Your device signs.
3. The server runs [the checks](#the-checks). Only then is the review approved. Nothing is asked in
   Pi, because the signature already proves you were there.
4. If the review changed between the challenge and the signature (a new round arrived), the approval
   is refused: you did not approve what is there now.

## The checks

- The challenge is one the server issued for this purpose, unused and under two minutes old.
  - *A failure means:* a wrong, reused, expired or borrowed challenge. A challenge is used up by the first answer, right or wrong.
- The ceremony type is `webauthn.create` or `webauthn.get` as expected.
  - *A failure means:* a registration answer used as an approval, or the reverse.
- The origin is `http://localhost:<port>` or `http://127.0.0.1:<port>` as served, and the page was not framed.
  - *A failure means:* an answer made on another page.
- The hash of the relying party id in `authenticatorData` is the hash of `localhost`.
  - *A failure means:* an answer made for another site.
- The user-present and user-verified flags are both set.
  - *A failure means:* nobody was there, or the device did not check who.
- The credential is one registered here, and its key still passes the store's checks.
  - *A failure means:* an unregistered key.
- The signature verifies over `authenticatorData` plus the SHA-256 of `clientDataJSON`.
  - *A failure means:* a bad signature, or one made by another key.
- The signature counter went up, when either side counts.
  - *A failure means:* a cloned key. An authenticator that always reports 0 is fine.

Keys are ES256 (P-256) or RS256 (RSA of 2048 bits or more). The attestation statement is not
examined: what makes a key trusted is your `y` on its fingerprint, not its make. A message that is
malformed in any way (extra bytes, a CBOR tag, a float, a nested map too deep) is refused, not
guessed at.

## The fallback

When no passkey is registered and you decline to register one, or the browser has none, **Approve
in Pi instead** marks the review "approved in page" and Pi asks `y` or `n`.
- **It counts as approved only after `y`,** and not if the review changed while you decided.
- **It is the old rule** (approve inside the waiting call) with the page as the place you pressed the button, and it is recorded
  as `page-and-pi`.
- **It is also open when a passkey is registered,** because it needs you in Pi.

## The store

`<agent folder>/jig-review/passkeys.json`, mode 0600, in a folder of mode 0700:

```json
{
  "version": 1,
  "passkeys": [
    {
      "credentialId": "…", "algorithm": "ES256", "publicKey": "…SPKI, base64…",
      "fingerprint": "…64 hex digits…", "signCount": 0,
      "createdAt": "2026-10-30T10:00:00.000Z", "confirmedAt": "2026-10-30T10:00:05.000Z"
    }
  ]
}
```

**It must stay outside anything the agent's shell can write.** Pi's agent folder is such a place.

The keys are public, so reading them reveals nothing; what matters is that nothing the agent controls
can add one. If the agent could write this file, it could register its own key. The review records
are kept under the same folder for the same reason: an approval that a command could write would be
worth nothing.

### A file that was tampered with

The decision: **trust only what passes every check, ignore and report the rest, and never write over
a file that cannot be read.**

- **The file is not JSON, not `{ "version": 1, "passkeys": [...] }`, over 1 MiB, a link, owned by another user, or writable by group or others:**
  - **No key is trusted.** The page says so, registration is refused, and nothing is written over it, so you can look at it. Fix or delete it. The fallback still works
- **An entry's fingerprint is not the SHA-256 of its public key, or it has no `confirmedAt`:**
  - **That entry is ignored** and reported in Pi and on the settings page. The fingerprint is what you confirmed, so a different key under it was never confirmed
- **An entry's key does not load, is not ES256 or RS256, is too weak, or has a damaged field:**
  - That entry is ignored and reported
- **Two entries name one key:**
  - The second is ignored

Ignored entries are dropped by the next write. These checks catch damage and a half-made edit. They
do not stop someone who can write the file from forging a whole consistent entry, which is why the
folder's protection is the real guard.

## Limits

- **Pi has one dialog slot.** The question about a new key and a page approval is asked with
  `ctx.ui.confirm`. If another dialog is open (a tool call asking you), the two compete. One
  approval, registration or removal runs at a time; a second is refused until the first is answered
  or its five minutes pass (counted as no).
- **A stolen cookie can make Pi ask you.** Someone with the session cookie can press Approve in Pi's
  name, which opens the fallback question, or ask to register a key, which shows a fingerprint.
  - Answer `n` unless you just did it yourself; nothing is stored or approved by asking.
  - One question runs at a time, so a flood of them cannot pile up, though it can keep a real approval waiting until answered.
- **No interactive Pi, no question.** The fallback, registering and removing need Pi to ask you.
  Without it they are refused, and nothing is approved.
- **A passkey proves you were there, not what you read.** The page shows the diff; your device only
  shows that you approved something. Approval is bound to the review and diff the page showed.
- **The page's own code is not a guard.** Everything the page does, a script could do. That is why each
  step is checked by the server, with something a script cannot make.
