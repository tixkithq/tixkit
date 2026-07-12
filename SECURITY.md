# Security Policy

The authoritative public product must be buildable, testable and securable without access to the private Cloud repository. Vulnerabilities in shared domain, API, checkout, workflow, SDK or Self-Hosted behavior are fixed in the public product first and consumed by Cloud through an immutable version update; private patches must not become a long-lived fork.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use the repository's **Security** tab and choose **Report a vulnerability** to create a private vulnerability report. Include:

- The affected component and version or commit.
- Preconditions and a minimal reproduction.
- Expected and observed behavior.
- Security impact, including tenant or permission boundaries.
- Any suggested mitigation.

Do not include real credentials, customer data, private payloads, or destructive proof-of-concept actions. If private reporting is unavailable, contact a repository maintainer through an existing private channel and ask for a secure reporting route before sharing details.

## What to expect

Maintainers will triage the report, determine affected surfaces, and coordinate remediation and disclosure. Response time depends on severity and maintainer availability; this file does not promise a fixed service-level agreement. Please allow a reasonable remediation window before public disclosure.

## Supported code

Security fixes target the current mainline and actively supported published releases. Historical commits, local modifications, unsupported forks, and end-of-life dependency combinations may require upgrading before a fix can be applied.

## Security invariants

- Tenant, organization, brand, permission, and environment boundaries must be enforced server-side.
- API keys, provider secrets, signing secrets, and database credentials stay out of browser bundles, URLs, logs, analytics, screenshots, fixtures, and persistent browser storage.
- Webhooks require signature verification over the unmodified request body and replay-safe handling.
- Generated docs, search indexes, build metadata, and OSS exports must not expose internal content or private source paths.
- Dependency or configuration findings must include reachability and runtime context; a scanner result alone does not prove exploitability.

Deployment hardening begins with [self-hosting configuration](docs/public/self-hosting/configuration.mdx) and [authentication](docs/public/self-hosting/authentication.mdx); webhook verification is covered in [the signature guide](docs/public/developers/webhooks/verify-signatures.mdx).
