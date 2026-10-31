---
ticket: "PROJ-112"
closedAt: "2026-05-21T10:00:00.000Z"
repositories:
  - "notification-service"
keys: []
identifiers:
  - "WelcomeEmailListener"
  - "EventBusConfig"
errors: []
---

## Problem
New customers received the welcome email twice.

## Cause
EventBusConfig registered WelcomeEmailListener twice, once in the base configuration and once in an extra profile.

## Fix
The listener is registered once, and a test counts the listeners on the bus.
