import { AxeBuilder } from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '../fixtures/validation-test';

export async function expectNoAxeViolations(
  page: Page,
  testInfo: TestInfo,
  context?: string,
  excludeContexts: string[] = [],
  disabledRules: string[] = [],
): Promise<void> {
  const builder = new AxeBuilder({ page }).include(context ?? 'body');
  for (const excludeContext of excludeContexts) {
    builder.exclude(excludeContext);
  }
  if (disabledRules.length > 0) {
    builder.disableRules(disabledRules);
  }
  const result = await builder.analyze();

  if (result.violations.length > 0) {
    await testInfo.attach('axe-violations', {
      body: JSON.stringify(result.violations, null, 2),
      contentType: 'application/json',
    });
  }

  expect(result.violations).toEqual([]);
}
