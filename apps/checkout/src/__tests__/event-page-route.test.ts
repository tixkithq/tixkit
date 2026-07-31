import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('event page route bundle boundaries', () => {
  it('does not expose the old checkout edit overlay route path', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/e/[eventId]/page.tsx'), 'utf8');

    expect(source).not.toContain('event-page-edit-overlay');
    expect(source).not.toContain('editMode');
    expect(source).not.toContain('query.edit');
    expect(source).not.toContain('query.token');
  });

  it('server-fetches hosted event page bootstrap data for the event-id route', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/e/[eventId]/page.tsx'), 'utf8');

    expect(source).toContain('getServerEventPageBootstrap');
    expect(source).toContain('initialBootstrap={initialBootstrap}');
    expect(source).toContain("export const dynamic = 'force-dynamic'");
  });

  it('server-fetches the same bootstrap payload for custom-domain slug routes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/[eventSlug]/page.tsx'), 'utf8');

    expect(source).toContain('getServerEventPageBootstrapBySlug');
    expect(source).toContain('initialBootstrap={initialBootstrap}');
  });

  it('does not render old event-page surfaces or HTML fallbacks in checkout runtime', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/e/[eventId]/event-page-client.tsx'),
      'utf8',
    );

    expect(source).toContain('EventPagePuckRender');
    expect(source).not.toContain('EventPageSurface');
    expect(source).not.toContain('renderModel');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    expect(source).not.toContain('sanitizePublishedEventPageHtml');
  });
});
