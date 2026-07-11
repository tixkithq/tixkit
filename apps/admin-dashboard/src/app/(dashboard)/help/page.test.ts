import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const helpSource = readFileSync('src/app/(dashboard)/help/page.tsx', 'utf8');

describe('HelpPage source', () => {
  it('uses the shared permission-aware Help registry', () => {
    expect(helpSource).toContain('dashboardHelpRegistry');
    expect(helpSource).toContain('filterHelpByPermissions');
    expect(helpSource).toContain('Search Help Center');
    expect(helpSource).not.toContain('Help center coming soon');
  });

  it('provides task, role, symptom, and support entry points through DocRouteId', () => {
    expect(helpSource).toContain('Start by role');
    expect(helpSource).toContain('Tasks by product area');
    expect(helpSource).toContain('Troubleshoot by symptom');
    expect(helpSource).toContain('dashboardDocUrl(routeId)');
    expect(helpSource).toContain('routeId="support"');
  });
});
