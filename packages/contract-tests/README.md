# `@tixkit/contract-tests`

## Purpose

Executable embed-host, webhook-consumer, SDK/API-consumer, and agent-platform contract profiles for third-party integrations.

## Consumers

Integration developers, CI pipelines, sandbox users, SDK examples, and Tixkit release validation.

## Status

Public beta. Publication is held at the Phase 8 external release gate.

## Installation

```sh
npm install --save-dev @tixkit/contract-tests
```

## Example

```ts
import { assertWebhookConsumerContract } from '@tixkit/contract-tests';

await assertWebhookConsumerContract({
  secret: process.env.TIXKIT_WEBHOOK_SECRET!,
  deliveries: capturedRequests,
});
```

## Public exports

The root entry point exports structured profile runners and assertion helpers for embed hosts, webhook consumers, SDK/API consumers, and agent-platform integrations. The package also exposes the `tixkit-contract-tests` CLI.

## Runtime

Profiles run locally or in CI and return structured findings; assertion helpers throw when a required contract fails.

## Configuration

The CLI accepts a profile name and sanitized JSON fixture, for example `tixkit-contract-tests webhook-consumer fixture.json`.

The live `agent-platform` profile validates direct `event.read`, aggregate-only `report.read`, `event.prepare`, `content.prepare`, `campaign.prepare` and `readiness.read` results plus the shared `event.publish` and approved `event.update` execution boundaries: client-credential authentication, explicit agent identity, tenant, idempotency, version and digest binding, consent/suppression and untrusted-content boundaries, canonical result and exact-replay evidence, rejection of approval or execution for direct-only actions, typed action preparation, canonical plan persistence, sponsor approval bound to immutable digests, idempotent execution, terminal plan evidence, and plan-bound audit inspection.

It publishes the selected event. Run it only in an isolated private-beta or Self-Hosted test tenant with an unpublished, disposable event that is ready to publish. Never target a production event. Put only environment-variable names in the fixture:

```json
{
  "baseUrl": "https://sandbox.example.test",
  "apiVersion": "2026-08-11",
  "sponsorAccessTokenEnv": "TIXKIT_CONFORMANCE_SPONSOR_TOKEN",
  "agentClientId": "tk_agent_example",
  "agentClientSecretEnv": "TIXKIT_CONFORMANCE_AGENT_SECRET",
  "delegationGrantId": "delegation_example",
  "resourceId": "event_disposable",
  "campaignEmailTemplateKey": "event-announcement",
  "planId": "plan_conformance_20260730",
  "idempotencyPrefix": "agent.conformance.20260730"
}
```

```sh
TIXKIT_CONFORMANCE_SPONSOR_TOKEN='...' \
TIXKIT_CONFORMANCE_AGENT_SECRET='...' \
tixkit-contract-tests agent-platform agent-platform.fixture.json
```

The sponsor must own the agent principal and hold current `events.read`, `reports.read`, `events.write` and `messages.write` permission for the selected event. The agent credential must have an active delegation containing `events.read`, `reports.read`, `readiness.read`, `events.prepare`, `content.prepare`, `campaigns.prepare` and `events.execute` for that exact event. The fixture must name an eligible published email campaign template. Use a new plan ID and idempotency prefix for each event fixture.

## Security

Fixtures must not contain credentials, raw card data, or buyer PII. The agent-platform CLI resolves short-lived test credentials from named environment variables and never includes them in findings. Webhook profiles use test secrets and validate signatures, timestamps, duplicates, and ordering without fabricating payments.

## Validation

Run the package typecheck, lint, unit tests, pack dry-run, and clean external-install profile before release.

## Compatibility

Profiles target the current and previous supported Embed Contract versions and the repository API version declared by their package release.

## Related guides

- [Test webhooks](../../docs/public/developers/webhooks/testing.mdx)
- [Embed the widget](../../docs/public/developers/widget/embedding.mdx)
- [Connect an agent through the Platform API](../../docs/public/platform/agent-platform.mdx)
