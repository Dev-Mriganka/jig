---
ticket: "PROJ-110"
closedAt: "2026-05-07T10:00:00.000Z"
repositories:
  - "invoice-service"
keys: []
identifiers:
  - "InvoiceConsumer"
  - "DeadLetterQueue"
errors:
  - "WARN Message moved to dead-letter queue after 5 attempts"
---

## Problem
Invoice messages piled up in the dead-letter queue although the consumer reported no errors.

## Cause
InvoiceConsumer acknowledged each message before processing it, so a crash during processing lost it and the redelivery failed.

## Fix
The message is acknowledged after it was processed and saved. Processing is safe to repeat.
