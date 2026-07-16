import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'packages/widget/package.json'), 'utf8'));
const version = packageJson.version;
const widgetSource = readFileSync(join(root, 'packages/widget/src/index.ts'), 'utf8');
if (!widgetSource.includes(`export const TIXKIT_WIDGET_VERSION = '${version}';`))
  throw new Error('Widget telemetry version must match packages/widget/package.json.');
const contractVersion = '1.0';
const outputDirectory = resolve(root, process.argv[2] ?? 'artifacts/widget');
const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const commit = process.env.GITHUB_SHA ?? headCommit;
if (commit !== headCommit) throw new Error('GITHUB_SHA does not match the checked-out commit.');
const commitEpoch = Number(
  execFileSync('git', ['show', '-s', '--format=%ct', commit], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
);
const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH ?? commitEpoch);
if (!Number.isInteger(sourceDateEpoch) || sourceDateEpoch < 0)
  throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer.');
if (sourceDateEpoch !== commitEpoch)
  throw new Error('SOURCE_DATE_EPOCH must equal the verified source commit timestamp.');
const timestamp = new Date(sourceDateEpoch * 1000).toISOString();
const releaseDirty = execFileSync(
  'git',
  [
    'status',
    '--porcelain',
    '--',
    'packages/widget',
    'packages/embed-core',
    'scripts/build-widget-release.mjs',
  ],
  { cwd: root, encoding: 'utf8' },
).trim();
if (process.env.TIXKIT_RELEASE_BUILD === '1' && releaseDirty)
  throw new Error('Release builds require clean widget, embed-core, and release-builder sources.');

function hash(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest('base64');
}

function normalizeSourceMap(mapPath) {
  const sourceMap = JSON.parse(readFileSync(mapPath, 'utf8'));
  if (!Array.isArray(sourceMap.sources) || sourceMap.sources.length === 0) {
    throw new Error('Widget source map must contain source paths.');
  }

  sourceMap.sourceRoot = 'tixkit:///';
  sourceMap.sources = sourceMap.sources.map((source) => {
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error('Widget source map contains an invalid source path.');
    }
    const absoluteSource = resolve(dirname(mapPath), source);
    const repositoryPath = relative(root, absoluteSource);
    if (
      repositoryPath.length === 0 ||
      repositoryPath === '..' ||
      repositoryPath.startsWith(`..${sep}`) ||
      isAbsolute(repositoryPath)
    ) {
      throw new Error(`Widget source map escapes the repository: ${source}`);
    }
    const canonicalPath = repositoryPath.split(sep).join('/');
    if (
      !canonicalPath.startsWith('packages/widget/') &&
      !canonicalPath.startsWith('packages/embed-core/')
    ) {
      throw new Error(`Widget source map contains an unexpected source: ${canonicalPath}`);
    }
    return canonicalPath;
  });

  const canonicalMap = `${JSON.stringify(sourceMap)}\n`;
  if (canonicalMap.includes(root)) {
    throw new Error('Widget source map contains the local checkout path.');
  }
  writeFileSync(mapPath, canonicalMap);
}

function build(directory) {
  mkdirSync(directory, { recursive: true });
  const file = `tixkit-widget-${version}.js`;
  const output = join(directory, file);
  execFileSync(
    join(root, 'node_modules/.bin/esbuild'),
    [
      'packages/widget/src/browser.ts',
      '--bundle',
      '--minify',
      '--format=esm',
      '--sourcemap=external',
      '--sources-content=true',
      '--alias:@tixkit/embed-core=./packages/embed-core/src/index.ts',
      `--outfile=${output}`,
    ],
    { cwd: root, stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } },
  );
  normalizeSourceMap(`${output}.map`);
  return { file, output, map: `${output}.map` };
}

const proofA = mkdtempSync(join(tmpdir(), 'tixkit-widget-a-'));
const proofB = mkdtempSync(join(tmpdir(), 'tixkit-widget-b-'));
try {
  const first = build(proofA);
  const second = build(proofB);
  const firstBytes = readFileSync(first.output);
  const secondBytes = readFileSync(second.output);
  const firstMap = readFileSync(first.map);
  const secondMap = readFileSync(second.map);
  if (!firstBytes.equals(secondBytes) || !firstMap.equals(secondMap)) {
    throw new Error('Widget release build is not reproducible.');
  }
  if (firstBytes.length > 45_000)
    throw new Error('Widget browser bundle exceeds the 45,000 byte performance budget.');
  if (firstMap.length > 150 * 1024)
    throw new Error('Widget source map exceeds the 150 KiB budget.');

  const sha256 = hash(firstBytes, 'sha256');
  const sha384 = hash(firstBytes, 'sha384');
  const mapSha256 = hash(firstMap, 'sha256');
  const manifest = {
    schemaVersion: 1,
    widgetVersion: version,
    contractVersion,
    apiCompatibility: { version: '2026-01-01', routeMajor: 'v1' },
    commit,
    dirty: Boolean(releaseDirty),
    timestamp,
    immutable: true,
    files: {
      widget: {
        path: first.file,
        bytes: statSync(first.output).size,
        sha256,
        sha384,
        integrity: `sha384-${sha384}`,
        cacheControl: 'public, max-age=31536000, immutable',
        contentType: 'text/javascript; charset=utf-8',
        accessControlAllowOrigin: '*',
      },
      sourceMap: {
        path: `${first.file}.map`,
        bytes: statSync(first.map).size,
        sha256: mapSha256,
        cacheControl: 'public, max-age=31536000, immutable',
        contentType: 'application/json; charset=utf-8',
        accessControlAllowOrigin: '*',
      },
    },
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const checksumBytes = `${Buffer.from(sha256, 'base64').toString('hex')}  ${first.file}\n${Buffer.from(mapSha256, 'base64').toString('hex')}  ${first.file}.map\n`;
  const existingManifestPath = join(outputDirectory, 'manifest.json');
  const existingManifest = existsSync(existingManifestPath)
    ? JSON.parse(readFileSync(existingManifestPath, 'utf8'))
    : undefined;
  if (existingManifest?.immutable === true && existingManifest.widgetVersion === version) {
    const existingWidget = join(outputDirectory, first.file);
    const existingMap = join(outputDirectory, `${first.file}.map`);
    const existingChecksums = join(outputDirectory, 'checksums.txt');
    const identical =
      readFileSync(existingManifestPath, 'utf8') === manifestBytes &&
      existsSync(existingWidget) &&
      existsSync(existingMap) &&
      existsSync(existingChecksums) &&
      readFileSync(existingWidget).equals(firstBytes) &&
      readFileSync(existingMap).equals(firstMap) &&
      readFileSync(existingChecksums, 'utf8') === checksumBytes;
    if (!identical) {
      throw new Error(
        `Immutable widget release collision for ${version}: use a new package version instead of replacing published bytes or provenance.`,
      );
    }
    process.stdout.write(`Verified existing immutable widget ${version} in ${outputDirectory}\n`);
  } else {
    rmSync(outputDirectory, { recursive: true, force: true });
    mkdirSync(outputDirectory, { recursive: true });
    copyFileSync(first.output, join(outputDirectory, first.file));
    copyFileSync(first.map, join(outputDirectory, `${first.file}.map`));
    writeFileSync(existingManifestPath, manifestBytes);
    writeFileSync(join(outputDirectory, 'checksums.txt'), checksumBytes);
    process.stdout.write(`Built reproducible widget ${version} in ${outputDirectory}\n`);
  }
} finally {
  rmSync(proofA, { recursive: true, force: true });
  rmSync(proofB, { recursive: true, force: true });
}
