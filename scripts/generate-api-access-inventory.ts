import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildRouteAccessInventory } from '../packages/api/src/__tests__/integration/route-access-inventory.ts';

const outputPath = resolve('docs/internal/security/api-route-access-inventory.json');
const inventory = await buildRouteAccessInventory();
const output = `${JSON.stringify(inventory, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8').catch(() => '');
  if (existing !== output) {
    console.error(
      'API route access inventory is stale. Run `bun run security:route-inventory:update`.',
    );
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, 'utf8');
  console.log(`Wrote ${inventory.routes.length} routes to ${outputPath}`);
}
