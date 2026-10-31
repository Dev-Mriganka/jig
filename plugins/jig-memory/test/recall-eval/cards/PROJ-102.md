---
ticket: "PROJ-102"
closedAt: "2026-03-11T10:00:00.000Z"
repositories:
  - "payments-worker"
keys:
  - "PROJ-77"
identifiers:
  - "PaymentWorker"
  - "ChargeRequest"
  - "IdempotencyKeyFilter"
  - "payments.retry.max-attempts"
errors:
  - "ERROR Duplicate charge detected for payment 88231"
---

## Problem
Customers were charged twice when the payment provider answered slowly and the worker sent the charge again.

## Cause
The retry built a new ChargeRequest with a new idempotency key, so the provider treated it as a second payment.

## Fix
The key is created once per payment and reused by every retry. Retries are limited to three attempts.
