#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checkOnly = process.argv.includes('--check');

const matrix = [
  {
    name: 'Next.js',
    path: 'apps/sdk-next-demo/package.json',
    workspace: '@tixkit/sdk-next-demo',
    tasks: ['typecheck', 'build'],
  },
  {
    name: 'SvelteKit',
    path: 'apps/sdk-sveltekit-demo/package.json',
    workspace: '@tixkit/sdk-sveltekit-demo',
    tasks: ['typecheck', 'build'],
  },
  {
    name: 'Vue / Nuxt',
    path: 'apps/sdk-nuxt-demo/package.json',
    workspace: '@tixkit/sdk-nuxt-demo',
    tasks: ['typecheck', 'build'],
  },
  {
    name: 'Astro',
    path: 'apps/sdk-astro-demo/package.json',
    workspace: '@tixkit/sdk-astro-demo',
    tasks: ['typecheck', 'build'],
  },
  {
    name: 'Remix',
    path: 'apps/sdk-remix-demo/package.json',
    workspace: '@tixkit/sdk-remix-demo',
    tasks: ['typecheck', 'build'],
  },
  {
    name: 'React Native',
    path: 'apps/sdk-react-native-demo/package.json',
    workspace: '@tixkit/sdk-react-native-demo',
    tasks: ['typecheck'],
  },
];

for (const item of matrix) {
  const manifest = JSON.parse(readFileSync(new URL(`../${item.path}`, import.meta.url), 'utf8'));
  if (manifest.name !== item.workspace)
    throw new Error(`${item.name}: expected workspace ${item.workspace} at ${item.path}`);
  for (const task of item.tasks) {
    if (!manifest.scripts?.[task]) throw new Error(`${item.name}: missing ${task} script`);
    if (!checkOnly)
      execFileSync('bun', ['run', '--filter', item.workspace, task], {
        cwd: root,
        env: task === 'build' ? { ...process.env, NODE_ENV: 'production' } : process.env,
        stdio: 'inherit',
      });
  }
}

console.log(
  `${checkOnly ? 'Validated' : 'Executed'} ${matrix.length} representative SDK demo configurations.`,
);
