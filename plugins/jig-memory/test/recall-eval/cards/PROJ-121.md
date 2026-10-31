---
ticket: "PROJ-121"
closedAt: "2026-07-23T10:00:00.000Z"
repositories:
  - "coupon-service"
keys: []
identifiers:
  - "CouponExpiryTest"
  - "Clock"
errors:
  - "FAILED CouponExpiryTest.expiresAtMidnight - expected true but was false"
---

## Problem
A unit test failed only in the hour around midnight UTC.

## Cause
CouponExpiryTest read the real clock twice, and the date changed between the two reads.

## Fix
The test uses a fixed Clock, and the code under test receives the clock instead of reading it.
