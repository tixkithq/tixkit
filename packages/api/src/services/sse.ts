import type { Writable } from 'node:stream';

async function waitForWritable(stream: Writable): Promise<boolean> {
  if (stream.destroyed || stream.writableEnded) return false;
  return new Promise((resolve) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('close', onClose);
      stream.off('error', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    stream.once('drain', onDrain);
    stream.once('close', onClose);
    stream.once('error', onClose);
  });
}

/** Write one atomic SSE frame and wait when the client applies backpressure. */
export async function writeSseEvent(
  stream: Writable,
  event: string,
  data: unknown,
  id?: string,
): Promise<boolean> {
  if (stream.destroyed || stream.writableEnded) return false;
  const frame = `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return stream.write(frame) || waitForWritable(stream);
}
