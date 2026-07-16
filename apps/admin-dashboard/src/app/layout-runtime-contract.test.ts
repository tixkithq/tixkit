import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootLayoutSource = readFileSync('src/app/layout.tsx', 'utf8');

describe('admin root layout runtime contract', () => {
  it('forces every inherited route to render with request-time runtime configuration', () => {
    expect(rootLayoutSource).toMatch(/export const dynamic\s*=\s*['"]force-dynamic['"];/);
    expect(rootLayoutSource).toContain('await connection();');
    expect(rootLayoutSource).toContain('const runtimeConfig = parseAdminRuntimeConfig();');
    expect(rootLayoutSource.indexOf('await connection();')).toBeLessThan(
      rootLayoutSource.indexOf('const runtimeConfig = parseAdminRuntimeConfig();'),
    );
  });

  it('does not substitute a build-time runtime configuration', () => {
    expect(rootLayoutSource).not.toContain('process.env.NEXT_PHASE');
    expect(rootLayoutSource).not.toContain('PHASE_PRODUCTION_BUILD');
    expect(rootLayoutSource).not.toContain('buildRuntimeConfig');
  });
});
