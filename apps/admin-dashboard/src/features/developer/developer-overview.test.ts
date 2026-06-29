import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const overviewSource = readFileSync('src/features/developer/developer-overview.tsx', 'utf8');

describe('DeveloperOverview source', () => {
  it('links developer resources to real in-dashboard guides', () => {
    expect(overviewSource).toContain('API Reference');
    expect(overviewSource).toContain('Webhook Guide');
    expect(overviewSource).toContain('Open guide');
    expect(overviewSource).toContain('`${routes.help}#developer-api`');
    expect(overviewSource).not.toContain('Coming soon');
  });
});
