---
ticket: "PROJ-109"
closedAt: "2026-04-30T10:00:00.000Z"
repositories:
  - "auth-service"
keys: []
identifiers:
  - "TokenRefreshService"
  - "JwtValidator"
  - "401 /auth/refresh"
errors:
  - "JwtException: Token expired at 2026-04-29T10:00:00Z"
---

## Problem
Mobile users were logged out at random: the refresh call answered 401 with token expired for a token that was just issued.

## Cause
The auth service and the gateway clocks differed by 90 seconds, and JwtValidator accepted no skew.

## Fix
JwtValidator allows 120 seconds of clock skew, and both hosts now sync their time from the same source.
