---
name: acme-jira
description: "Acme's Jira rules on top of the jira skill: the ACME project and its issue keys, priorities, story points, and how a pull request is linked. Use whenever the user names an ACME-123 style key, or asks to create, update, move or comment on an Acme Jira issue."
---

# Jira at Acme

Read the `jira` skill first; this adds the company's rules. A real company writes here what the generic skill cannot know:
its projects, its fields, its workflow and its manners.

## Projects and keys

- **ACME** is the product project. Keys look like `ACME-123`. If the user gives a title and no key, `search` for it and
  confirm the key before acting. Acme's setup lists ACME as the project, so a `search` with no JQL lists its newest issues, and
  `create` refuses any other project.
- Branches, commits and pull request titles start with the key (`feature/ACME-123`, `ACME-123: add the order filter`), and Jig
  refuses ones that do not. Use the key of the issue the work is for.

## Creating an issue

- **Priority** is `Highest`, `High`, `Medium`, `Low` or `Lowest`. Use `Medium` unless the user says otherwise; Acme's defaults
  fill it in and the preview marks it "from your defaults".
- **Story Points** is a number from 1 to 13. Ask the user; do not guess one.
- Leave `reporter` out: Jira uses the account the agent signs in with.

## Moving an issue

- Call `transitions` first. At Acme, `In Review` needs a pull request link in a comment, and `Done` is the QA team's to set:
  stop at `In Review` and say so.

## The pull request link

- After `pr create`, comment on the issue with the pull request's address and one line on what changed. Write nothing that
  only you can open: no local paths, no names of your own notes.
- Acme's Jira is hosted outside the company network. Never put a customer's name, email, phone number or any other personal data in an issue or a
  comment. Production results are masked for that reason, and a comment must not undo it.
