import { describe, expect, it, vi } from 'vitest';
import {
  executeApiExplorerRequest,
  issueApiExplorerRequestUrl,
} from '../components/api-explorer-target.js';

describe('API explorer sandbox target authority', () => {
  it('issues only exact allowed-origin versioned API targets', () => {
    expect(
      issueApiExplorerRequestUrl({
        allowedOrigins: ['https://sandbox.example.test'],
        selectedOrigin: 'https://sandbox.example.test',
        requestPath: '/events?limit=10',
      }),
    ).toBe('https://sandbox.example.test/v1/events?limit=10');
  });

  it.each([
    ['https://attacker.test', '/events'],
    ['http://sandbox.example.test', '/events'],
    ['https://user:secret@sandbox.example.test', '/events'],
    ['https://sandbox.example.test/path', '/events'],
    ['https://sandbox.example.test', '//attacker.test/events'],
    ['https://sandbox.example.test', '/events\n'],
  ])(
    'rejects hostile target %s %s without network execution',
    async (selectedOrigin, requestPath) => {
      const request = vi.fn<typeof globalThis.fetch>();
      await expect(
        executeApiExplorerRequest(
          {
            allowedOrigins:
              selectedOrigin === 'https://attacker.test'
                ? ['https://sandbox.example.test']
                : [selectedOrigin],
            selectedOrigin,
            requestPath,
          },
          {},
          request,
        ),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
});
