#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_TYPESCRIPT_VERSION = '7.0.2';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function workspacePackagePaths(root) {
  const manifests = [path.join(root, 'package.json')];
  const rootManifest = readJson(path.join(root, 'package.json'));
  for (const workspacePattern of rootManifest.workspaces ?? []) {
    if (typeof workspacePattern !== 'string' || !workspacePattern.endsWith('/*')) {
      throw new Error(`Unsupported workspace pattern: ${String(workspacePattern)}`);
    }
    const directory = path.join(root, workspacePattern.slice(0, -2));
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(directory, entry.name, 'package.json');
      if (existsSync(manifest)) manifests.push(manifest);
    }
  }
  return manifests.toSorted();
}

function scaffoldTemplateManifestPaths(root) {
  const templatesRoot = path.join(root, 'packages', 'cli', 'src', 'templates');
  if (!existsSync(templatesRoot)) return [];
  const manifests = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name === 'package.json.template') manifests.push(entryPath);
    }
  };
  visit(templatesRoot);
  return manifests.toSorted();
}

function installedCompilerVersion(root) {
  const compilerPath = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(compilerPath)) return null;
  const result = spawnSync(process.execPath, [compilerPath, '--version'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return /^Version\s+([^\s]+)\s*$/.exec(result.stdout)?.[1] ?? null;
}

export function validateTypeScriptVersion({
  root = repoRoot,
  compilerVersion = installedCompilerVersion(root),
} = {}) {
  const errors = [];
  const manifests = workspacePackagePaths(root);
  const templateManifests = scaffoldTemplateManifestPaths(root);

  if (compilerVersion === null) {
    errors.push('node_modules/typescript/bin/tsc: installed compiler is missing or not executable');
  } else if (compilerVersion !== REQUIRED_TYPESCRIPT_VERSION) {
    errors.push(
      `node_modules/typescript/bin/tsc: must report ${REQUIRED_TYPESCRIPT_VERSION}, found ${compilerVersion}`,
    );
  }

  for (const manifestPath of manifests) {
    const relativePath = path.relative(root, manifestPath) || 'package.json';
    const manifest = readJson(manifestPath);
    const declaredVersions = [
      ['dependencies', manifest.dependencies?.typescript],
      ['devDependencies', manifest.devDependencies?.typescript],
      ['peerDependencies', manifest.peerDependencies?.typescript],
      ['optionalDependencies', manifest.optionalDependencies?.typescript],
    ].filter(([, version]) => version !== undefined);

    if (declaredVersions.length === 0) {
      errors.push(`${relativePath}: must declare TypeScript ${REQUIRED_TYPESCRIPT_VERSION}`);
      continue;
    }

    for (const [section, version] of declaredVersions) {
      if (version !== REQUIRED_TYPESCRIPT_VERSION) {
        errors.push(
          `${relativePath}: ${section}.typescript must be exactly ${REQUIRED_TYPESCRIPT_VERSION}, found ${String(version)}`,
        );
      }
    }
  }

  for (const manifestPath of templateManifests) {
    const relativePath = path.relative(root, manifestPath);
    const version = readJson(manifestPath).devDependencies?.typescript;
    if (version !== REQUIRED_TYPESCRIPT_VERSION) {
      errors.push(
        `${relativePath}: devDependencies.typescript must be exactly ${REQUIRED_TYPESCRIPT_VERSION}, found ${String(version)}`,
      );
    }
  }

  const rootManifest = readJson(path.join(root, 'package.json'));
  if (rootManifest.overrides?.typescript !== REQUIRED_TYPESCRIPT_VERSION) {
    errors.push(
      `package.json: overrides.typescript must be exactly ${REQUIRED_TYPESCRIPT_VERSION}`,
    );
  }

  const lockPath = path.join(root, 'bun.lock');
  if (!existsSync(lockPath)) {
    errors.push('bun.lock: lockfile is required');
  } else {
    const lockfile = readFileSync(lockPath, 'utf8');
    const resolvedPackages = [
      ...lockfile.matchAll(
        /\["(typescript|@typescript\/typescript-[^@"]+)@([^"+]+)(?:\+[^"\]]*)?"/g,
      ),
    ].map((match) => ({ packageName: match[1], version: match[2] }));
    if (resolvedPackages.length === 0) {
      errors.push('bun.lock: no TypeScript resolution found');
    }
    for (const resolution of resolvedPackages) {
      if (resolution.version !== REQUIRED_TYPESCRIPT_VERSION) {
        errors.push(
          `bun.lock: ${resolution.packageName} must resolve to ${REQUIRED_TYPESCRIPT_VERSION}, found ${resolution.version}`,
        );
      }
    }
  }

  return {
    errors,
    manifestCount: manifests.length,
    templateManifestCount: templateManifests.length,
  };
}

export function main() {
  const result = validateTypeScriptVersion();
  if (result.errors.length > 0) {
    console.error('TypeScript version validation failed:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Validated TypeScript ${REQUIRED_TYPESCRIPT_VERSION} across ${result.manifestCount} workspace manifests, ${result.templateManifestCount} scaffold templates, bun.lock, and the installed compiler`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
