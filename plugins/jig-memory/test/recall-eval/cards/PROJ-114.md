---
ticket: "PROJ-114"
closedAt: "2026-06-04T10:00:00.000Z"
repositories:
  - "import-service"
keys: []
identifiers:
  - "MaxUploadSizeExceededException"
  - "spring.servlet.multipart.max-file-size"
  - "413 /imports"
errors:
  - "MaxUploadSizeExceededException: Maximum upload size exceeded"
---

## Problem
Importing a CSV file of 40 MB failed with 413 although the limit in the docs is 100 MB.

## Cause
The proxy allowed 1 MB bodies and the application allowed 10 MB files; the docs described neither.

## Fix
Both limits are raised to 100 MB from one value in the chart, and the docs name it.
