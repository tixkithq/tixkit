import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/components/contextual-help.tsx', 'utf8');

describe('ContextualHelp source', () => {
  it('matches the current route and filters by permissions', () => {
    expect(source).toContain('usePathname()');
    expect(source).toContain('helpForPath(pathname)');
    expect(source).toContain('filterHelpByPermissions');
  });

  it('links summaries, tasks, and symptoms through canonical documentation routes', () => {
    expect(source).toContain('dashboardDocUrl(entry.docRouteId)');
    expect(source).toContain('dashboardDocUrl(task.docRouteId)');
    expect(source).toContain('dashboardDocUrl(item.docRouteId)');
  });
});
