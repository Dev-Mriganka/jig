---
ticket: "PROJ-117"
closedAt: "2026-06-25T10:00:00.000Z"
repositories:
  - "orders-api"
keys: []
identifiers:
  - "MaskingConverter"
errors: []
---

## Problem
Customer email addresses appeared in clear text in the error log.

## Cause
Exceptions printed the request body, and the log masking only covered the message, not the stack trace.

## Fix
MaskingConverter also covers the stack trace, and the request body is no longer part of the exception text.
