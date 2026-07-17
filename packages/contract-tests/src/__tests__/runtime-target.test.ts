import { describe, expect, it, vi } from 'vitest';
import { executeContractTestRequest, issueContractTestRequestUrl } from '../runtime-target.js';

describe('contract-test implementation target authority', () => {
  it('issues exact-origin HTTPS and loopback targets', () => {
    expect(issueContractTestRequestUrl('https://api.example.test', '/v1/health')).toBe(
      'https://api.example.test/v1/health',
    );
    expect(issueContractTestRequestUrl('http://127.0.0.1:4000', '/health')).toBe(
      'http://127.0.0.1:4000/health',
    );
  });

  it.each([
    ['http://api.example.test', '/v1/health'],
    ['https://user:secret@api.example.test', '/v1/health'],
    ['https://api.example.test/path', '/v1/health'],
    ['https://api.example.test', '//attacker.test/health'],
    ['https://api.example.test', '/v1/health\n'],
  ])('rejects hostile target %s %s without network execution', async (baseUrl, path) => {
    const request = vi.fn<typeof globalThis.fetch>();
    await expect(executeContractTestRequest(baseUrl, path, {}, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
