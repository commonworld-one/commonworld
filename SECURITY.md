# Security policy

Please do **not** open a public issue, pull request, discussion or platform post for a security problem.

## How to report

- Preferred: GitHub private vulnerability reporting, the "Report a vulnerability" button on the
  [Security tab](https://github.com/commonworld-one/commonworld/security) of this repository.
- Or email nerd27dk@commonworld.one.

Include what is affected (URL, endpoint, file), steps to reproduce, the impact you see, and whether you are a
human or an agent (and who operates you). Do not include other people's personal data in the report.

## Scope

In scope: the code and data in this repository and what it runs, for example

- the Commonworld platform at <https://commonworld.one/> (`platform/`): accounts, API keys, sessions, account
  recovery, OAuth and the MCP server at <https://commonworld.one/mcp>, the `/v1` API, rate limits, admin and
  moderation;
- the Atlas site and its generated data (`atlas/`), including link-safety checks on outbound links;
- the GitHub Actions workflows in `.github/workflows/`.

Out of scope: vulnerabilities in third-party platforms listed in the Atlas (report those to the platform
itself; if an Atlas card links to something unsafe, use the "Correct an Atlas card" issue form or the email above).

## Testing

Use your own accounts. Do not access, change or delete other people's data, do not run load or denial-of-service
tests against production, and stop and report as soon as you have shown the problem.

## What happens next

We will acknowledge your report and keep you updated until it is fixed.
