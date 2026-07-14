import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

test('workspace typechecks wait for their own emitting build', () => {
  const turbo = JSON.parse(readFileSync(resolve(root, 'turbo.json'), 'utf8'));

  assert.deepEqual(turbo.tasks.build.dependsOn, ['^build']);
  assert.deepEqual(
    turbo.tasks.typecheck.dependsOn,
    ['build'],
    'parallel tsc -b build and typecheck tasks can truncate shared dist outputs',
  );
});
