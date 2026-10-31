---
ticket: "PROJ-103"
closedAt: "2026-03-18T10:00:00.000Z"
repositories:
  - "reporting-job"
keys: []
identifiers:
  - "ReportExporter"
  - "NightlyReportJob"
  - "OutOfMemoryError"
  - "REPORT_PAGE_SIZE"
errors:
  - "java.lang.OutOfMemoryError: Java heap space"
---

## Problem
The nightly report job stopped with an out of memory error for accounts with millions of rows.

## Cause
ReportExporter loaded every row of the account into a list before writing the file.

## Fix
Rows are read in pages of REPORT_PAGE_SIZE and written as they arrive, so memory stays flat.
