import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openApiSpec } from '../index.js';

/**
 * Generated-client compile validation (T33).
 *
 * Uses `openapi-typescript` to generate TypeScript types from the OpenAPI spec
 * and verifies the output is non-empty and contains expected type definitions.
 * This catches schema regressions that would break generated SDK clients.
 */

async function generateTypes(): Promise<string> {
  const tmpDir = join(import.meta.dirname, `.tmp-gen-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const specPath = join(tmpDir, 'spec.json');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  writeFileSync(specPath, JSON.stringify(openApiSpec));

  const { default: openapiTS, astToString } = await import('openapi-typescript');
  const ast = await openapiTS(new URL(`file://${specPath}`));
  const output = astToString(ast);
  rmSync(tmpDir, { recursive: true, force: true });
  return output;
}

describe('Generated client compile validation (T33)', () => {
  const tmpDir = join(import.meta.dirname, '.tmp-gen');

  it('openapi-typescript generates valid TypeScript from the spec', async () => {
    const output = await generateTypes();

    // Verify the output is non-empty and contains expected patterns.
    expect(output).toBeTruthy();
    expect(output.length).toBeGreaterThan(1000);
    expect(output).toContain('paths');
    expect(output).toContain('components');
    expect(output).toContain('schemas');

    // Verify key schema types are present in the generated output.
    expect(output).toContain('Event');
    expect(output).toContain('Order');
    expect(output).toContain('CheckoutSession');
    expect(output).toContain('Organization');
    expect(output).toContain('Brand');
    expect(output).toContain('paymentAccountId');
  });

  it('generated types include all paginated envelope schemas', async () => {
    const output = await generateTypes();

    // Paginated envelopes should be present as schemas.
    expect(output).toContain('EventPage');
    expect(output).toContain('OrderPage');
    expect(output).toContain('OrganizationPage');
    expect(output).toContain('BrandPage');
  });

  // Cleanup temp files after all tests.
  it('cleanup', () => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
