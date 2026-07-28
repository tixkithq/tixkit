import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const MYSQL_IMAGE =
  'mysql:8.4@sha256:d36d39a64cd12a5c1cc9e6aa2bfb5f8d4c81a2f6586e0a04a9ae13939db02209';
const MYSQL_COMMAND = '--log-bin-trust-function-creators=1';

const workflowContracts = [
  { path: '.github/workflows/ci.yml', serviceCount: 1 },
  { path: '.github/workflows/release-dry-run.yml', serviceCount: 1 },
  { path: '.github/workflows/trusted-ci.yml', serviceCount: 1 },
  { path: '.github/workflows/trusted-release-dry-run.yml', serviceCount: 1 },
];

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function workflowServiceBlocks(workflow) {
  const lines = workflow.split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)services:\s*(?:#.*)?$/.exec(lines[index]);
    if (!match) continue;

    const servicesIndentation = match[1].length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const content = line.trim();
      const lineIndentation = line.length - line.trimStart().length;
      if (content && !content.startsWith('#') && lineIndentation <= servicesIndentation) break;
      if (
        !content ||
        content.startsWith('#') ||
        lineIndentation !== servicesIndentation + 2 ||
        !/^[A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(content)
      ) {
        continue;
      }

      const serviceIndentation = lineIndentation;
      const block = [line];
      for (let blockCursor = cursor + 1; blockCursor < lines.length; blockCursor += 1) {
        const blockLine = lines[blockCursor];
        const blockContent = blockLine.trim();
        const blockIndentation = blockLine.length - blockLine.trimStart().length;
        if (blockContent && !blockContent.startsWith('#') && blockIndentation <= serviceIndentation)
          break;
        block.push(blockLine);
      }
      blocks.push(block.join('\n'));
    }
  }

  return blocks;
}

function isCompatibleMigrationService(block) {
  const escapedImage = MYSQL_IMAGE.replaceAll('.', '\\.');
  const [header] = block.split('\n', 1);
  const childIndentation = ' '.repeat(header.length - header.trimStart().length + 2);
  return (
    new RegExp(`^${childIndentation}image:\\s+.*${escapedImage}.*$`, 'm').test(block) &&
    new RegExp(
      `^${childIndentation}command:\\s+.*--log-bin-trust-function-creators=1.*$`,
      'm',
    ).test(block)
  );
}

test('every workflow-owned MySQL 8.4 migration service enables function creator migrations', () => {
  const workflowPaths = workflowContracts.map(({ path }) => path);
  const discoveredWorkflowPaths = readdirSync(resolve(root, '.github/workflows'))
    .filter((name) => name.endsWith('.yml'))
    .map((name) => `.github/workflows/${name}`)
    .filter((path) => {
      const workflow = readFileSync(resolve(root, path), 'utf8');
      return (
        workflowServiceBlocks(workflow).some((block) => block.includes(MYSQL_IMAGE)) &&
        workflow.includes('db:migrate:mysql')
      );
    })
    .sort();

  assert.deepEqual(
    discoveredWorkflowPaths,
    workflowPaths,
    'workflow contract inventory must cover every pinned MySQL 8.4 migration workflow',
  );

  for (const { path, serviceCount } of workflowContracts) {
    const workflow = readFileSync(resolve(root, path), 'utf8');
    const services = workflowServiceBlocks(workflow).filter((block) => block.includes(MYSQL_IMAGE));

    assert.equal(
      services.length,
      serviceCount,
      `${path} must keep its pinned MySQL service inventory`,
    );
    assert.match(workflow, /db:migrate:mysql/, `${path} must execute the MySQL migration chain`);
    assert.equal(
      services.filter(isCompatibleMigrationService).length,
      serviceCount,
      `${path} must enable migration 0065's MySQL capability on the same service block`,
    );
  }

  assert.deepEqual(workflowPaths, [...workflowPaths].sort(), 'workflow inventory must stay sorted');
});

test('comment-only and misplaced commands cannot satisfy the MySQL service contract', () => {
  const invalidWorkflow = `services:
  mysql:
    image: ${MYSQL_IMAGE}
    # command: ${MYSQL_COMMAND}
    env:
      command: ${MYSQL_COMMAND}
  redis:
    image: redis:8
    command: ${MYSQL_COMMAND}
`;

  const [mysql] = workflowServiceBlocks(invalidWorkflow);
  assert.equal(isCompatibleMigrationService(mysql), false);
  assert.equal(countMatches(invalidWorkflow, new RegExp(MYSQL_COMMAND, 'g')), 3);
});

test('the development compose MySQL service keeps the same migration prerequisite', () => {
  const compose = readFileSync(resolve(root, 'infra/docker-compose.yml'), 'utf8');

  assert.match(compose, new RegExp(`image: ${MYSQL_IMAGE.replaceAll('.', '\\.')}`));
  assert.match(compose, /command: \['--log-bin-trust-function-creators=1'\]/);
});
