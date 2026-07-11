# `@tixkit/contract-tests`

Executable contract profiles for third-party Tixkit integrations. Profiles return structured findings and throw in assertion mode, making them suitable for local tests and CI.

```ts
import { assertWebhookConsumerContract } from '@tixkit/contract-tests';

await assertWebhookConsumerContract({
  secret: process.env.TIXKIT_WEBHOOK_SECRET!,
  deliveries: capturedRequests,
});
```

The CLI accepts JSON on disk: `tixkit-contract-tests webhook-consumer fixture.json`. Fixtures must contain no production credentials or buyer data.
