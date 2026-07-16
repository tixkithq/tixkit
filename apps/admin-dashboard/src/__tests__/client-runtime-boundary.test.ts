import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const clientFiles = [
  'app/user/page.tsx',
  'app/(dashboard)/settings/profile/page.tsx',
  'context/runtime-config-provider.tsx',
  'context/admin-user-provider.tsx',
  'context/permission-provider.tsx',
] as const;

describe('admin client runtime boundary', () => {
  it('keeps Node-only runtime configuration out of client entrypoints', () => {
    for (const file of clientFiles) {
      const source = readFileSync(resolve(process.cwd(), 'src', file), 'utf8');
      expect(source).not.toMatch(/runtime-config-server|auth-server|node:crypto/u);
    }
  });
});
