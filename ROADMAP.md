# Tixkit Roadmap

This roadmap describes direction, not a release promise. Priorities can change as runtime evidence, security work, compatibility, and contributor capacity change.

## Current priorities

- Complete one shared product across three operating paths: Tixkit Cloud, the hosted Platform API capability, and Tixkit Self-Hosted.
- Keep Cloud and self-hosted behavior aligned through the same API, OpenAPI, checkout, webhook, workflow, migration, and SDK contracts.
- Keep checkout, inventory, ticket delivery, check-in, exports, and provider workflows durable and tenant-safe.
- Maintain synchronized API, OpenAPI, SDK, dashboard, example, and documentation contracts.
- Make the operator, integrator, self-hoster, and contributor golden paths reproducible from a clean environment.
- Strengthen accessibility, browser coverage, observability, recovery, and deterministic release validation.
- Make the authoritative public repository independently buildable, releasable and operable without private-repository access.

The accepted operating model and remaining completion work are defined in [the open-core product and completion plan](docs/completion/open-core-platform-plan.md). Cloud is the default organizer path, Platform API is a capability of Cloud rather than a separate deployment, and Self-Hosted is the infrastructure-control path. The authoritative public repository contains the shared product and complete Self-Hosted runtime; a separate private Cloud repository consumes immutable public releases. Availability claims remain subject to release and operational proof.

## How work is accepted

An item is complete only when its runtime behavior, types, security boundaries, documentation, tests, generated artifacts, and release/export validation agree. A design note, scaffold, or unverified prototype is not a shipped capability.

## Proposals

Open a focused feature request describing the user problem, affected persona, current workaround, contract implications, and evidence that the change belongs in Tixkit. Do not treat an issue, roadmap entry, or candidate idea as a commitment. See [CONTRIBUTING.md](CONTRIBUTING.md) for implementation expectations.

The public documentation describes supported behavior. Internal planning documents and completion ledgers are not public product commitments.
