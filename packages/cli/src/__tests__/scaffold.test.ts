import { mkdtemp, rm, readFile, readdir, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { kebabCase, titleCase, normalizeProjectName, scaffold } from '../scaffold.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('scaffold helpers', () => {
  it('kebab-cases input', () => {
    expect(kebabCase('My Event App')).toBe('my-event-app');
    expect(kebabCase('myEventApp')).toBe('my-event-app');
    expect(kebabCase('MyEventApp')).toBe('my-event-app');
    expect(kebabCase('my-event-app')).toBe('my-event-app');
  });

  it('title-cases input', () => {
    expect(titleCase('my-event-app')).toBe('My Event App');
    expect(titleCase('MyEventApp')).toBe('My Event App');
  });

  it('normalizes project names', () => {
    expect(normalizeProjectName('My Event App')).toBe('my-event-app');
  });
});

describe('scaffold', () => {
  let targetDir: string;

  beforeEach(async () => {
    targetDir = await tempDir('tixkit-scaffold-');
  });

  afterEach(async () => {
    await rm(targetDir, { recursive: true, force: true });
  });

  it('rejects target directories outside the repo', async () => {
    const result = await scaffold({
      targetDir,
      template: 'nextjs',
      projectName: 'my-app',
      skipGit: true,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('must be inside the Tixkit monorepo');
  });

  it('rejects a non-empty target directory', async () => {
    await mkdir(path.join(targetDir, 'existing'), { recursive: true });
    const result = await scaffold({
      targetDir,
      template: 'nextjs',
      projectName: 'my-app',
      skipGit: true,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not empty');
  });
});

describe('scaffold inside repo', () => {
  // Tests that need a directory inside the repo use a fixture under
  // packages/cli so workspace:* dependency resolution and the repo root
  // discovery both work.
  const fixtureBase = path.resolve(import.meta.dirname, '../../.test-scaffold');
  let targetDir: string;

  beforeEach(async () => {
    await mkdir(fixtureBase, { recursive: true });
    targetDir = await mkdtemp(path.join(fixtureBase, 'run-'));
  });

  afterEach(async () => {
    await rm(targetDir, { recursive: true, force: true });
  });

  it('generates a nextjs app with rendered placeholders', async () => {
    const result = await scaffold({
      targetDir,
      template: 'nextjs',
      projectName: 'my-event-app',
      port: 3400,
      brandId: 'brd_custom',
      eventId: 'evt_custom',
      ticketTypeId: 'tt_custom',
      skipGit: true,
    });
    if (!result.ok) {
      throw new Error(result.message);
    }

    const files = await readdir(targetDir, { recursive: true });
    expect(files).toContain('package.json');
    expect(files).toContain('tsconfig.json');
    expect(files).toContain('next.config.mjs');
    expect(files).toContain(path.join('app', 'page.tsx'));
    expect(files).toContain(path.join('app', 'tixkit-demo.tsx'));
    expect(files).toContain(path.join('app', 'api', 'tixkit', 'checkout', 'route.ts'));
    expect(files).toContain(path.join('app', 'api', 'tixkit', 'webhook', 'route.ts'));

    const pkg = JSON.parse(await readFile(path.join(targetDir, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('my-event-app');
    expect(pkg.dependencies['@tixkit/next']).toBe('workspace:*');

    const tsconfig = await readFile(path.join(targetDir, 'tsconfig.json'), 'utf8');
    expect(tsconfig).toContain('tsconfig.base.json');
    expect(tsconfig).not.toContain('__ROOT__');

    const demo = await readFile(path.join(targetDir, 'app', 'tixkit-demo.tsx'), 'utf8');
    expect(demo).toContain('brd_custom');
    expect(demo).toContain('evt_custom');
    expect(demo).toContain('tt_custom');
    expect(demo).toContain('NEXT_PUBLIC_TIXKIT_CHECKOUT_URL');
    expect(demo).toContain('http://localhost:3000');

    const envExample = await readFile(path.join(targetDir, '.env.local.example'), 'utf8');
    expect(envExample).toContain('NEXT_PUBLIC_APP_URL=http://localhost:3400');
  });
});
