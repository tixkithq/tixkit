import { describe, expect, it, vi } from 'vitest';
import { issueAdminUploadCompletionUrl, issueAdminUploadUrl, putAdminUploadBytes } from './api';

describe('admin upload target authorities', () => {
  it('normalizes configured-origin upload and same-origin completion targets', () => {
    expect(issueAdminUploadUrl('http://localhost:9000/uploads/object?signature=abc')).toBe(
      'http://localhost:9000/uploads/object?signature=abc',
    );
    expect(issueAdminUploadCompletionUrl('/v1/upload-artifacts/upl_1/complete')).toBe(
      'http://localhost:4000/v1/upload-artifacts/upl_1/complete',
    );
  });

  it.each([
    'https://evil.example.test/object',
    'http://user:secret@localhost:9000/object',
    'javascript:alert(1)',
    'http://localhost:9000/object#fragment',
    'http://localhost:9000/object\nX-Test: yes',
  ])('rejects a hostile upload target: %s', (target) => {
    expect(() => issueAdminUploadUrl(target)).toThrow('The upload target is invalid');
  });

  it.each([
    '//evil.example.test/v1/upload-artifacts/upl_1/complete',
    'https://evil.example.test/v1/upload-artifacts/upl_1/complete',
    '/v1/upload-artifacts/upl_1/complete?redirect=evil',
    '/v1/upload-artifacts/../complete',
  ])('rejects a hostile completion target: %s', (target) => {
    expect(() => issueAdminUploadCompletionUrl(target)).toThrow(
      'The upload completion target is invalid',
    );
  });

  it('does not invoke fetch or XHR for a rejected upload target', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await putAdminUploadBytes(
      {
        artifactId: 'upl_1',
        uploadUrl: 'https://evil.example.test/steal',
        uploadHeaders: {},
        completeUrl: '/v1/upload-artifacts/upl_1/complete',
        expiresAt: '2026-08-21T00:00:00.000Z',
      },
      new File(['safe'], 'proof.txt', { type: 'text/plain' }),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_upload_url', message: 'The upload target is invalid' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
