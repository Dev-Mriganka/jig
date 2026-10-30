# What happens to a result

What `jig-core` does to a tool's result before the model sees it. Back to the
[jig-core overview](../README.md).

After a tool runs, jig-core changes the result in this order, and replaces it
only when something changed:
1. **Redact.** Every resolved secret value, with its base64, base64url,
   URL-encoded and hex forms, and strings of an unmistakable shape: GitHub
   tokens, AWS access key ids, private-key blocks, JWTs and Slack tokens. This
   covers the text, the structured content and the details, however deep.
2. **Mask,** for production results and for a test environment set to `mask:
   true`, unless the tool declares that it masks its own results. An image
   cannot be masked, so it is replaced by a note. What is masked, and how, is in
   [Masking](masking.md).
3. **Cap.** Text over 50 000 characters is cut to its first 8 000, with a line
   that names the spill file and says to read it with the `read` tool.
   - The file is `<state folder>/spill/<session>/<tool call id>.txt`, private,
     and holds the text as the model would have seen it.
   - Pi's own `read`, `bash`, `powershell`, `grep`, `find` and `ls` cut their
     own output and are left alone.

If a step cannot be done, the result is withheld and the model reads "result
withheld: it could not be masked" (or "redacted"). Pi lets an unchanged result
through when a hook fails, so jig-core never leaves a failure to Pi.

**A limit of redaction.** It finds a secret in the forms above. A secret that
sits inside a longer Base64 string, as in an HTTP `Basic` header, is not caught;
the raw value, which a tool normally prints, always is.
