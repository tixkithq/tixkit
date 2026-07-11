import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/features/developer/developer-console-guide.tsx', 'utf8');

describe('DeveloperConsoleGuide source', () => {
  it('presents environment, health, safe first-call, and SDK registry data', () => {
    expect(source).toContain('NEXT_PUBLIC_TIXKIT_API_BASE_URL');
    expect(source).toContain('Check API health');
    expect(source).toContain('sdkSnippetRegistry');
    expect(source).toContain('Authorization: Bearer $TIXKIT_API_KEY');
  });

  it('does not accept or persist API key input', () => {
    expect(source).not.toContain('localStorage.setItem');
    expect(source).not.toMatch(/type=["']password["']/);
    expect(source).toMatch(/This page never asks for,\s+stores, or sends a secret\./);
  });

  it('renders unavailable states instead of misleading zero counts', () => {
    expect(source).toContain('Credential status unavailable');
    expect(source).toContain('Webhook status unavailable');
    expect(source).toContain('activeKeys: number | null');
  });
});
