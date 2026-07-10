import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { writeSseEvent } from '../services/sse.js';

describe('SSE writer', () => {
  it('writes an atomic SSE frame', async () => {
    const stream = new PassThrough();
    stream.setEncoding('utf8');
    const chunks: string[] = [];
    stream.on('data', (chunk: string) => chunks.push(chunk));

    await expect(writeSseEvent(stream, 'scan', { id: 'scan_1' }, 'scan_1')).resolves.toBe(true);
    expect(chunks.join('')).toBe('id: scan_1\nevent: scan\ndata: {"id":"scan_1"}\n\n');
    stream.end();
  });

  it('waits for drain when the client applies backpressure', async () => {
    const stream = new PassThrough({ highWaterMark: 1 });
    const pending = writeSseEvent(stream, 'scan', { payload: 'x'.repeat(100) });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    stream.resume();
    await expect(pending).resolves.toBe(true);
    stream.end();
  });

  it('does not write to a closed stream', async () => {
    const stream = new PassThrough();
    stream.destroy();
    await expect(writeSseEvent(stream, 'scan', {})).resolves.toBe(false);
  });
});
