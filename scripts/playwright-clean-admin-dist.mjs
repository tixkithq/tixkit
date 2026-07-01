import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const adminDashboardRoot = path.resolve(
  fileURLToPath(new URL('../apps/admin-dashboard', import.meta.url)),
);

export function resolveAdminDistDir(input, options = {}) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('ADMIN_DASHBOARD_NEXT_DIST_DIR must be a non-empty relative path');
  }
  if (input !== input.trim()) {
    throw new Error(
      'ADMIN_DASHBOARD_NEXT_DIST_DIR must not contain leading or trailing whitespace',
    );
  }
  if (input.includes('\0')) {
    throw new Error('ADMIN_DASHBOARD_NEXT_DIST_DIR must not contain NUL bytes');
  }
  if (path.isAbsolute(input)) {
    throw new Error('ADMIN_DASHBOARD_NEXT_DIST_DIR must be relative to apps/admin-dashboard');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(input)) {
    throw new Error('ADMIN_DASHBOARD_NEXT_DIST_DIR contains unsupported characters');
  }

  const segments = input.split('/');
  if (
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    segments[0] !== '.next' ||
    segments.length < 2
  ) {
    throw new Error('ADMIN_DASHBOARD_NEXT_DIST_DIR must be under .next/');
  }

  const root = path.resolve(options.root ?? adminDashboardRoot);
  const absolutePath = path.resolve(root, input);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolutePath.startsWith(rootPrefix)) {
    throw new Error('ADMIN_DASHBOARD_NEXT_DIST_DIR escapes apps/admin-dashboard');
  }

  return {
    absolutePath,
    relativePath: input,
  };
}

export async function cleanAdminDistDir(input, options = {}) {
  const resolved = resolveAdminDistDir(input, options);
  await rm(resolved.absolutePath, { force: true, recursive: true });
  return resolved;
}

async function main() {
  const requestedPath =
    process.argv[2] ?? process.env.ADMIN_DASHBOARD_NEXT_DIST_DIR ?? process.env.NEXT_DIST_DIR;
  if (!requestedPath) {
    throw new Error('Set ADMIN_DASHBOARD_NEXT_DIST_DIR or NEXT_DIST_DIR before cleaning');
  }

  await cleanAdminDistDir(requestedPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
