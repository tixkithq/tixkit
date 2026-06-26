import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('Next.js SDK bundle isolation', () => {
  it('client module does not import server module or node:crypto', () => {
    const clientSource = readFileSync(
      fileURLToPath(new URL('../client.tsx', import.meta.url)),
      'utf-8',
    );
    expect(clientSource).not.toContain('node:crypto');
    expect(clientSource).not.toContain('createHmac');
    expect(clientSource).not.toContain('timingSafeEqual');
    expect(clientSource).not.toContain('verifyGateKitWebhook');
    expect(clientSource).not.toContain('createGateKitClient');
    expect(clientSource).not.toContain("from './server'");
  });

  it('server module imports node:crypto', () => {
    const serverSource = readFileSync(
      fileURLToPath(new URL('../server.ts', import.meta.url)),
      'utf-8',
    );
    expect(serverSource).toContain('node:crypto');
  });
});
