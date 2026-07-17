import { describe, expect, it, vi } from 'vitest';
import { issueQuickstartHealthUrl, waitForHealth, type QuickstartService } from '../quickstart.js';

describe('quickstart health target authority', () => {
  it('issues only the fixed loopback service targets', () => {
    expect(issueQuickstartHealthUrl('api')).toBe('http://localhost:4000/health');
    expect(issueQuickstartHealthUrl('checkout')).toBe('http://localhost:3000/');
    expect(() => issueQuickstartHealthUrl('attacker' as QuickstartService)).toThrow(
      /Unknown quickstart service/u,
    );
  });

  it('does not execute a request when target issuance rejects', async () => {
    const request = vi.fn<typeof globalThis.fetch>();
    await expect(waitForHealth('attacker' as QuickstartService, 1, 0, request)).resolves.toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
