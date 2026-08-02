# Security Policy

## Supported versions

Talaria Code is in active pre-release development. Security fixes land on the
latest `main` release; older pre-release builds are not maintained.

| Version            | Supported |
|--------------------|-----------|
| latest (`main`)    | ✅        |
| older pre-releases | ❌        |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report privately: open the repository’s **Security** tab and click
**“Report a vulnerability”** (GitHub Private Vulnerability Reporting). The report
stays confidential until a fix is available.

Please include:
- a description of the issue and its impact;
- steps to reproduce (or a proof of concept);
- the affected version / commit;
- any suggested remediation.

## What to expect

- Acknowledgement within **5 business days**.
- An initial assessment and, if confirmed, a remediation plan.
- Coordinated disclosure — we agree on a timeline before any public advisory,
  and credit you in it if you wish.

## Scope

Talaria Code runs locally and is built to keep your code on your machine
(edit-path confinement, egress secret-scanning, machine-scoped spawn/egress
settings). Reports about those boundaries — or any path that sends workspace
content or secrets somewhere unintended, runs code outside the approval flow,
or bypasses the edit gate — are especially welcome.
