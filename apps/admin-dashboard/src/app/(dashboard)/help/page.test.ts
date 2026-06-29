import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const helpSource = readFileSync('src/app/(dashboard)/help/page.tsx', 'utf8');

describe('HelpPage source', () => {
  it('contains real dashboard guides instead of the old placeholder', () => {
    expect(helpSource).toContain('Create, configure, and publish an event');
    expect(helpSource).toContain('Track orders and process refunds');
    expect(helpSource).toContain('Use API keys and webhooks safely');
    expect(helpSource).not.toContain('Help center coming soon');
  });

  it('links guide actions to real dashboard routes', () => {
    expect(helpSource).toContain('href: routes.events');
    expect(helpSource).toContain('href: routes.orders');
    expect(helpSource).toContain('href: routes.developerApiKeys');
    expect(helpSource).toContain('href: routes.developerWebhooks');
  });
});
