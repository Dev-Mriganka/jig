# Masking

What `jig-core` masks in production results, and how. Back to the
[jig-core overview](../README.md). Masking is one step of
[What happens to a result](results.md).

Production results are masked before the model or a session file sees them. Only
**customer personal data** is masked. Identifiers never are, so a ticket stays
debuggable. The code is in `src/mask/`.

| Found | Becomes |
|---|---|
| Email addresses | `email#3fa9c1` |
| Phone numbers: in a phone field, written with `+` and a country code, or in a North American format | `phone#3fa9c1-0132`. The last four digits stay, so a number can still be matched to a ticket |
| Names in name fields, usernames and logins | `name#3fa9c1`, `user#3fa9c1` |
| Public IP addresses, IPv4 and IPv6 | `ip#3fa9c1` |
| Card numbers: in a card field, or digit groups that pass the Luhn check | `card ****1111` |
| Street addresses, coordinates, dates of birth, government and bank identifiers, card security codes and expiry, health and biometric data, credentials and tokens | `[removed:address]`, `[removed:geo]` and so on. Nothing of the value is kept, not even a state or country |
| Fields a company plugin names (below) | `personal#3fa9c1` |

**Never masked:**
- identifiers: names ending in `id`, UUIDs, ObjectIds, trace ids, SKUs, device
  identifiers such as MAC and IMEI, and bare runs of digits of any length;
- internal IP addresses;
- business names: company, product, account and location names.

How it decides:
- **Field names are judged by their words.** `crmAccountId` is crm, account, id,
  never a substring such as `mac`. A last word that describes a value
  (`phoneType`, `emailVerified`) keeps the field out of the rules.
- **Text is scanned as well.** That covers JSON inside a log line, URL query
  strings, `key=value` pairs and free text, with percent-encoding decoded up to
  three layers. Names are found by field name only: a name written inside a
  free-text note is not recognised.
- **Tokens stay the same all day.** A token is the first three bytes of an
  HMAC-SHA256 of the category and the value, under a random key for the UTC day.
  The same email, phone number or IP address gives the same token in every
  result and every spelling (case, spacing, IPv6 notation), and a different
  token tomorrow. The key is 32 random bytes in `<state>/mask/<YYYY-MM-DD>.key`
  (file 0600, folder 0700), and keys older than two days are deleted.
- **A company plugin adds field names** that hold personal data in its own data,
  with `config.addMaskFields(fields)`. They are compared without case or
  separators, beat every built-in rule, and their values become `personal#`
  tokens. They apply to the next result, and tokens do not change, because the
  key is the day's. A name the masker refuses (one with no letters or digits)
  is left out, and `/jig` shows it as a start-up problem. The other names still
  apply.
- **It fails closed.** A string whose structure cannot be parsed safely
  (malformed percent-encoding, JSON cut off mid-object, an unterminated quote)
  becomes `[removed:unparseable]`, and only that string. In a text of several
  lines, only the lines that cannot be parsed are replaced; when the fault runs
  across lines, such as JSON cut off between them, the whole text is. A result
  over 16 MiB, 2 million values or 64 levels of nesting, or a value that is not
  JSON-like, makes masking throw, and the caller drops the whole result.
