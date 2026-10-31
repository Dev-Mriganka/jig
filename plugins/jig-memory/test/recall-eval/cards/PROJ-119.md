---
ticket: "PROJ-119"
closedAt: "2026-07-09T10:00:00.000Z"
repositories:
  - "invoice-service"
keys: []
identifiers:
  - "InvoiceScheduler"
  - "ShedLock"
errors: []
---

## Problem
The monthly invoice run started on both instances at once and created every invoice twice.

## Cause
InvoiceScheduler was a plain scheduled method, which runs on each instance of the service.

## Fix
The method takes a ShedLock lock named for the run, so one instance runs it and the other skips.
