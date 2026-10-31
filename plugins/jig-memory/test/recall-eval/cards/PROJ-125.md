---
ticket: "PROJ-125"
closedAt: "2026-08-20T10:00:00.000Z"
repositories:
  - "webhook-service"
keys: []
identifiers:
  - "WebhookDispatcher"
  - "410 /webhooks/{id}/deliver"
errors: []
---

## Problem
Deliveries to a deleted customer endpoint were retried every hour for weeks, although the endpoint answered 410 Gone.

## Cause
WebhookDispatcher treated every status of 400 and above as a temporary failure.

## Fix
A 410 answer disables the endpoint at once, and other 4xx answers stop after five attempts.
