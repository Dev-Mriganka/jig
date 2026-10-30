# Not verified yet

What is built and tested here, and what needs a real browser and a real device. Back to the
[jig-review overview](../README.md).

The plugin is tested against a fake `jig-core`, a fake Pi, real git repositories, a real local server
and a **fake authenticator**: test keys made with `node:crypto` (P-256 and RSA) sign the challenges as a
device would. That proves the server's checks. It does not prove a real browser and device agree with them.

- **Windows Hello through WSL's localhost forwarding.** The page is opened in a Windows browser, and reaches the server in WSL as `localhost:<port>`
  - *What to try:* Run `/code-review`, open the link, press Approve, register a passkey, and approve. Edge and Chrome should offer Windows Hello. Check that the fingerprint Pi shows is the one the settings page lists
- **Touch ID** in Safari and in Chrome on macOS
  - *What to try:* The same, on a Mac
- **RS256 from a real TPM.** Windows Hello often makes RSA keys
  - *What to try:* Register on Windows and look at the algorithm on the settings page
- **`localhost` resolving to `::1` first**
  - *What to try:* If the page does not open, a browser that does not fall back from `::1` to `127.0.0.1` needs the server to listen on both
- **A security key** (FIDO2) with a PIN
  - *What to try:* Register and approve with it
- **Pi's dialog slot** while an agent turn is running
  - *What to try:* Approve in the page during a turn, with the fallback, and see that Pi's question appears
- **The page's look** at narrow widths and in a dark theme
  - *What to try:* The page is the reference's; only the approval panel and the settings page are new

A passkey made by a device that reports a signature counter, and one that always reports 0, are both
covered by the tests. What real authenticators send is not: a surprise there would show as a refusal with a
reason on the page.
