# `@tixkit/contract-tests`

## Purpose

Executable embed-host, webhook-consumer, and SDK/API-consumer contract profiles for third-party integrations.

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

The root entry point exports structured profile runners and assertion helpers for embed hosts, webhook consumers, and SDK/API consumers. The package also exposes the `tixkit-contract-tests` CLI.

## Runtime

Profiles run locally or in CI and return structured findings; assertion helpers throw when a required contract fails.

## Configuration

The CLI accepts a profile name and sanitized JSON fixture, for example `tixkit-contract-tests webhook-consumer fixture.json`.

## Security

Fixtures must not contain production credentials, raw card data, or buyer PII. Webhook profiles use test secrets and validate signatures, timestamps, duplicates, and ordering without fabricating payments.

## Validation

Run the package typecheck, lint, unit tests, pack dry-run, and clean external-install profile before release.

## Compatibility

Profiles target the current and previous supported Embed Contract versions and the repository API version declared by their package release.

## Related guides

- [Test webhooks](../../docs/public/developers/webhooks/testing.mdx)
- [Embed the widget](../../docs/public/developers/widget/embedding.mdx)
