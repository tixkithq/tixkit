import { describe, expect, it } from 'vitest';
import { assertPublicArtifactSafe } from '../lib/public-artifact-safety.js';

describe('public artifact safety', () => {
  it('rejects actual Tixkit and provider credential grammars nested in generated text', () => {
    for (const secret of [
      `tk_${'a'.repeat(64)}`,
      `tk_sandbox_${'b'.repeat(64)}`,
      'tk_oat_real_token_material',
      'whsec_real_secret_material',
      'Bearer abcdefghijklmnopqrstuvwxyz',
      'buyer@real-domain.invalid',
    ]) {
      expect(() =>
        assertPublicArtifactSafe('nested.json', JSON.stringify({ nested: { secret } })),
      ).toThrow('credential or non-placeholder PII');
    }
  });

  it('permits documented inert placeholders and sandbox-shaped labels without material', () => {
    expect(() =>
      assertPublicArtifactSafe('safe.json', 'buyer@example.test tk_sandbox_REDACTED'),
    ).not.toThrow();
  });
});
