import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const overviewSource = readFileSync('src/features/developer/developer-overview.tsx', 'utf8');

describe('DeveloperOverview source', () => {
  it('links developer resources to distinct canonical documentation routes', () => {
    expect(overviewSource).toContain('API Reference');
    expect(overviewSource).toContain('Webhook Guide');
    expect(overviewSource).toContain("dashboardDocUrl('apiReference')");
    expect(overviewSource).toContain("dashboardDocUrl('webhookEvents')");
    expect(overviewSource).not.toContain('#developer-api');
    expect(overviewSource).not.toContain('Coming soon');
  });

  it('preserves unknown integration state during loading and query failures', () => {
    expect(overviewSource).toContain('keysLoading || keysError ? null');
    expect(overviewSource).toContain('webhooksLoading || webhooksError ? null');
    expect(overviewSource).not.toContain('totalWebhooks={(webhooks ?? []).length}');
  });
});
