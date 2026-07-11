import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/components/command-menu.tsx', 'utf8');

describe('CommandMenu documentation actions', () => {
  it('offers exact Help, API, operator, and webhook destinations', () => {
    expect(source).toContain('heading="Documentation"');
    expect(source).toContain("dashboardDocUrl('events')");
    expect(source).toContain("dashboardDocUrl('apiReference')");
    expect(source).toContain("dashboardDocUrl('webhookTroubleshooting')");
    expect(source).toContain('href: routes.help');
  });

  it('permission-gates operator and developer documentation', () => {
    expect(source).toContain("requiredPermission: 'events.read'");
    expect(source).toContain("requiredPermission: 'developers.write'");
  });
});
