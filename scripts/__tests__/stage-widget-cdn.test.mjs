import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function runValidator(directory, env) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ['scripts/stage-widget-cdn.mjs', directory, '--verify-only'],
      {
        cwd: root,
        env,
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (status) => resolveRun({ status, stderr }));
  });
}

test('candidate validator accepts a complete prefix and refuses a missing artifact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-cdn-verify-'));
  const widget = Buffer.from('export const widget = true;');
  const sourceMap = Buffer.from('{"version":3}');
  const cacheControl = 'public, max-age=31536000, immutable';
  const manifest = {
    widgetVersion: '0.1.0',
    files: {
      widget: {
        path: 'tixkit-widget-0.1.0.js',
        bytes: widget.length,
        sha256: createHash('sha256').update(widget).digest('base64'),
        cacheControl,
      },
      sourceMap: {
        path: 'tixkit-widget-0.1.0.js.map',
        bytes: sourceMap.length,
        sha256: createHash('sha256').update(sourceMap).digest('base64'),
        cacheControl,
      },
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const checksums = Buffer.from('checksums\n');
  writeFileSync(join(directory, manifest.files.widget.path), widget);
  writeFileSync(join(directory, manifest.files.sourceMap.path), sourceMap);
  writeFileSync(join(directory, 'manifest.json'), manifestBytes);
  writeFileSync(join(directory, 'checksums.txt'), checksums);

  const objects = new Map([
    [`/widget/v0.1.0/${manifest.files.widget.path}`, widget],
    [`/widget/v0.1.0/${manifest.files.sourceMap.path}`, sourceMap],
    ['/widget/v0.1.0/manifest.json', manifestBytes],
    ['/widget/v0.1.0/checksums.txt', checksums],
  ]);
  const server = createServer((request, response) => {
    const body = objects.get(request.url ?? '');
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'cache-control': cacheControl,
    });
    response.end(body);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert(address && typeof address === 'object');
  const env = {
    ...process.env,
    WIDGET_CDN_STAGING_BASE_URL: `http://127.0.0.1:${address.port}`,
  };
  try {
    const complete = await runValidator(directory, env);
    assert.equal(complete.status, 0, complete.stderr);

    objects.delete(`/widget/v0.1.0/${manifest.files.sourceMap.path}`);
    const partial = await runValidator(directory, env);
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, /source map|not readable|tixkit-widget/i);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(directory, { recursive: true, force: true });
  }
});
