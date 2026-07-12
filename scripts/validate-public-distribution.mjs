#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePublicDistribution } from './lib/public-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
);
validatePublicDistribution(manifest, root);
console.log(
  `Validated public distribution: ${manifest.source.applications.length} apps, ${manifest.source.packages.length} packages, ${manifest.release.packages.length} release packages, ${manifest.release.images.length} images.`,
);
