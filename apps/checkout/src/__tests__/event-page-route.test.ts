import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('event page route bundle boundaries', () => {
  it('loads the edit overlay only from the edit-mode branch', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/e/[eventId]/page.tsx'), 'utf8');

    expect(source).not.toMatch(/import\s+EventPageEditOverlay\s+from/);
    expect(source).toContain("await import('./event-page-edit-overlay')");
  });

  it('server-fetches hosted event page bootstrap data for the non-edit route', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/e/[eventId]/page.tsx'), 'utf8');

    expect(source).toContain('publicApi.getEventPageBootstrap');
    expect(source).toContain('initialBootstrap={initialBootstrap}');
    expect(source).toContain('export const revalidate = 60');
  });
});
