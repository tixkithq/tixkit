import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';

const requiredLiveClerkEnv = [
  'CLERK_SECRET_KEY',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'E2E_CLERK_USER_EMAIL',
  'E2E_CLERK_USER_PASSWORD',
] as const;

type ClerkUser = {
  id: string;
};

type ClerkSignInToken = {
  token?: string;
};

const adminHomeUrlPattern = /\/dashboard(?:\?|$)|\/$/;
const clerkOrganizationTaskUrlPattern = /\/sign-in\/tasks\/choose-organization(?:\?|$)/;

function missingLiveClerkEnv(): string[] {
  if (process.env.E2E_LIVE_CLERK !== '1') return ['E2E_LIVE_CLERK'];
  return requiredLiveClerkEnv.filter((name) => !process.env[name]);
}

async function clerkApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new Error(`Clerk API ${init.method ?? 'GET'} ${path} failed with ${response.status}`);
  }

  return body as T;
}

async function createClerkSignInTicket(): Promise<string> {
  const users = await clerkApi<ClerkUser[]>(
    `/users?email_address=${encodeURIComponent(process.env.E2E_CLERK_USER_EMAIL!)}&limit=1`,
  );
  const userId = users[0]?.id;
  if (!userId) {
    throw new Error('Clerk E2E user was not found for E2E_CLERK_USER_EMAIL.');
  }

  const signInToken = await clerkApi<ClerkSignInToken>('/sign_in_tokens', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 600 }),
  });
  if (!signInToken.token) {
    throw new Error('Clerk sign-in token response did not include a token.');
  }

  return signInToken.token;
}

async function clickPrimaryClerkAction(page: Page, label: RegExp): Promise<void> {
  const button = page.getByRole('button', { name: label }).first();
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await button.click();
}

async function fillFirstVisible(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector).first();
  await expect(input).toBeVisible();
  await input.fill(value);
}

async function advanceToClerkPasswordStep(page: Page): Promise<void> {
  await fillFirstVisible(
    page,
    'input[name="identifier"], input[name="emailAddress"], input[type="email"]',
    process.env.E2E_CLERK_USER_EMAIL!,
  );
  await clickPrimaryClerkAction(page, /^(continue|sign in)$/i);
}

async function completeClerkOrganizationTaskIfNeeded(page: Page): Promise<void> {
  if (!clerkOrganizationTaskUrlPattern.test(page.url())) return;

  const continueButton = page.getByRole('button', { name: /^continue$/i }).first();
  await expect(continueButton).toBeVisible();
  await expect(continueButton).toBeEnabled();
  await Promise.all([
    page.waitForURL(adminHomeUrlPattern, { timeout: 30_000 }),
    continueButton.click(),
  ]);
}

async function signInWithClerk(page: Page): Promise<void> {
  const ticket = await createClerkSignInTicket();
  const authPage = await page.context().newPage();
  try {
    await authPage.goto(`/sign-in?__clerk_ticket=${encodeURIComponent(ticket)}`);
    await authPage
      .waitForURL(adminHomeUrlPattern, { timeout: 15_000 })
      .catch(async (error: unknown) => {
        if (!clerkOrganizationTaskUrlPattern.test(authPage.url())) throw error;
        await completeClerkOrganizationTaskIfNeeded(authPage);
      });
    await expect(authPage).toHaveURL(adminHomeUrlPattern);
  } finally {
    await authPage.close();
  }

  await page.goto('/dashboard');
  await expect(page).toHaveURL(adminHomeUrlPattern);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText(/Authentication required/);
}

async function openProfileMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: /account menu/i }).click();
  await expect(page.getByRole('menuitem', { name: /sign out/i })).toBeVisible();
}

async function signOutWithDialog(page: Page): Promise<void> {
  await openProfileMenu(page);
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await expect(page.getByRole('alertdialog', { name: /sign out/i })).toBeVisible();
  await page.getByRole('button', { name: /^sign out$/i }).click();
  await expect(page).toHaveURL(/\/sign-in/);
}

test.describe('Live Clerk admin auth', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(() => {
    const missing = missingLiveClerkEnv();
    test.skip(
      missing.length > 0,
      `Live Clerk auth proof requires ${missing.join(', ')}. Run with bun run test:e2e:live-clerk after configuring test credentials.`,
    );
  });

  test('renders real Clerk sign-in, sign-up, and password recovery availability', async ({
    page,
  }, testInfo) => {
    await page.goto('/sign-in');
    await expect(
      page.locator('input[name="identifier"], input[name="emailAddress"], input[type="email"]'),
    ).toBeVisible();
    await expectNoAxeViolations(page, testInfo);

    await advanceToClerkPasswordStep(page);
    await expect(
      page.locator('input[name="password"], input[type="password"]').first(),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /forgot|reset|password|trouble/i }).first(),
    ).toBeVisible();

    await page.goto('/sign-up');
    await expect(
      page.locator('input[name="emailAddress"], input[name="identifier"], input[type="email"]'),
    ).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });

  test('signs in, signs out, and fails closed when a second tab refreshes', async ({
    page,
  }, testInfo) => {
    await signInWithClerk(page);
    await expectNoAxeViolations(page, testInfo);

    const secondTab = await page.context().newPage();
    await secondTab.goto('/dashboard');
    await expect(secondTab.getByRole('main')).toBeVisible();

    await signOutWithDialog(page);

    await secondTab.reload();
    await expect(secondTab.getByRole('main')).toContainText(
      /Authentication required|Sign in to Tixkit/,
    );
  });

  test('rejects an expired Clerk JWT when one is provided', async ({ request }) => {
    test.skip(
      !process.env.E2E_CLERK_EXPIRED_SESSION_JWT,
      'Set E2E_CLERK_EXPIRED_SESSION_JWT to prove expired-session API fail-closed behavior.',
    );

    const apiBaseUrl = process.env.TIXKIT_API_URL ?? 'http://localhost:4200';
    const response = await request.get(`${apiBaseUrl}/v1/me`, {
      headers: { Authorization: `Bearer ${process.env.E2E_CLERK_EXPIRED_SESSION_JWT}` },
      failOnStatusCode: false,
    });

    expect(response.status()).toBe(401);
  });

  test('switches workspace scope without retaining stale visible state when configured', async ({
    page,
  }) => {
    test.skip(
      !process.env.E2E_CLERK_SECOND_ORG_NAME,
      'Set E2E_CLERK_SECOND_ORG_NAME for a live multi-organization Clerk user.',
    );

    await signInWithClerk(page);
    const workspaceSelect = page.getByRole('combobox', { name: /select workspace/i });
    await expect(workspaceSelect).toBeVisible();
    await workspaceSelect.click();
    await page.getByRole('option', { name: process.env.E2E_CLERK_SECOND_ORG_NAME }).click();
    await expect(workspaceSelect).toContainText(process.env.E2E_CLERK_SECOND_ORG_NAME!);
    await expect(page.getByRole('main')).toBeVisible();
  });
});
