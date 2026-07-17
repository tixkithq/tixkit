import { describe, expect, it, vi } from 'vitest';
import { issueDeveloperApiHealthUrl, probeDeveloperApiHealth } from './developer-console-guide';

describe('developer API health target authority', () => {
  it('issues only the health endpoint at the configured Platform API origin', () => {
    expect(issueDeveloperApiHealthUrl('https://api.example.test/v1')).toBe(
      'https://api.example.test/health',
    );
    expect(issueDeveloperApiHealthUrl('http://localhost:4000/v1/')).toBe(
      'http://localhost:4000/health',
    );
  });

  it.each([
    'javascript:alert(1)',
    'https://user:secret@api.example.test/v1',
    'https://api.example.test/v1/escape',
    'https://api.example.test/v1?target=health',
    'http://api.example.test/v1',
    'https://api.example.test/v1\nX-Test: yes',
  ])('rejects a hostile base without invoking transport: %s', async (baseUrl) => {
    const transport = vi.fn<typeof fetch>();
    await expect(probeDeveloperApiHealth(baseUrl, transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
