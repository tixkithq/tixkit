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

  it('generates a vue/nuxt app with rendered placeholders', async () => {
    const result = await scaffold({
      targetDir,
      template: 'vue',
      projectName: 'my-vue-app',
      port: 3500,
      brandId: 'brd_vue',
      eventId: 'evt_vue',
      ticketTypeId: 'tt_vue',
      skipGit: true,
    });
    if (!result.ok) {
      throw new Error(result.message);
    }

    const files = await readdir(targetDir, { recursive: true });
    expect(files).toContain('package.json');
    expect(files).toContain('nuxt.config.ts');
    expect(files).toContain('app.vue');
    expect(files).toContain(path.join('server', 'api', 'tixkit', 'webhook.post.ts'));

    const pkg = JSON.parse(await readFile(path.join(targetDir, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('my-vue-app');
    expect(pkg.dependencies['@tixkit/vue']).toBe('workspace:*');

    const appVue = await readFile(path.join(targetDir, 'app.vue'), 'utf8');
    expect(appVue).toContain('brd_vue');
    expect(appVue).toContain('evt_vue');
    expect(appVue).toContain('tt_vue');
    expect(appVue).not.toContain('__BRAND_ID__');
    expect(appVue).toContain('tixkitWidgetIframeAttributes');

    const webhook = await readFile(
      path.join(targetDir, 'server', 'api', 'tixkit', 'webhook.post.ts'),
      'utf8',
    );
    expect(webhook).toContain('verifyTixkitWebhook');
    expect(webhook).toContain('readRawBody');
    expect(webhook).toContain('Invalid JSON body');
    expect(webhook).not.toContain('__NAME__');
  });

  it('generates an astro app with rendered placeholders', async () => {
    const result = await scaffold({
      targetDir,
      template: 'astro',
      projectName: 'my-astro-app',
      port: 3600,
      brandId: 'brd_astro',
      eventId: 'evt_astro',
      ticketTypeId: 'tt_astro',
      skipGit: true,
    });
    if (!result.ok) {
      throw new Error(result.message);
    }

    const files = await readdir(targetDir, { recursive: true });
    expect(files).toContain('package.json');
    expect(files).toContain('astro.config.mjs');
    expect(files).toContain(path.join('src', 'pages', 'index.astro'));
    expect(files).toContain(path.join('src', 'pages', 'api', 'tixkit', 'webhook.ts'));

    const pkg = JSON.parse(await readFile(path.join(targetDir, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('my-astro-app');
    expect(pkg.dependencies['@tixkit/astro']).toBe('workspace:*');
    expect(pkg.devDependencies['@astrojs/node']).toBeDefined();

    const config = await readFile(path.join(targetDir, 'astro.config.mjs'), 'utf8');
    expect(config).toContain('3600');
    expect(config).not.toContain('__PORT__');

    const index = await readFile(path.join(targetDir, 'src', 'pages', 'index.astro'), 'utf8');
    expect(index).toContain('brd_astro');
    expect(index).toContain('evt_astro');
    expect(index).not.toContain('__EVENT_ID__');

    const webhook = await readFile(
      path.join(targetDir, 'src', 'pages', 'api', 'tixkit', 'webhook.ts'),
      'utf8',
    );
    expect(webhook).toContain('Invalid JSON body');
  });

  it('generates a remix app with rendered placeholders', async () => {
    const result = await scaffold({
      targetDir,
      template: 'remix',
      projectName: 'my-remix-app',
      port: 3700,
      brandId: 'brd_remix',
      eventId: 'evt_remix',
      ticketTypeId: 'tt_remix',
      skipGit: true,
    });
    if (!result.ok) {
      throw new Error(result.message);
    }

    const files = await readdir(targetDir, { recursive: true });
    expect(files).toContain('package.json');
    expect(files).toContain('vite.config.ts');
    expect(files).toContain(path.join('app', 'root.tsx'));
    expect(files).toContain(path.join('app', 'routes', '_index.tsx'));
    expect(files).toContain(path.join('app', 'routes', 'api.tixkit-webhook.ts'));

    const pkg = JSON.parse(await readFile(path.join(targetDir, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('my-remix-app');
    expect(pkg.dependencies['@tixkit/remix']).toBe('workspace:*');

    const index = await readFile(path.join(targetDir, 'app', 'routes', '_index.tsx'), 'utf8');
    expect(index).toContain('brd_remix');
    expect(index).toContain('evt_remix');
    expect(index).not.toContain('__BRAND_ID__');
    expect(index).toContain('tixkitWidgetIframeAttributes');

    const vite = await readFile(path.join(targetDir, 'vite.config.ts'), 'utf8');
    expect(vite).toContain('3700');
    expect(vite).not.toContain('__PORT__');

    const webhook = await readFile(
      path.join(targetDir, 'app', 'routes', 'api.tixkit-webhook.ts'),
      'utf8',
    );
    expect(webhook).toContain('Invalid JSON body');
  });
});
