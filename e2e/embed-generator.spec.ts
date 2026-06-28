import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const fixturesDir = path.resolve(import.meta.dirname, 'fixtures');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

// Mock widget script that defines the custom elements so they don't throw.
const mockWidgetScript = `
  class TixkitWidget extends HTMLElement {
    connectedCallback() {
      setTimeout(() => this.dispatchEvent(new CustomEvent('loaded', { detail: { eventId: this.getAttribute('event') } })), 0);
    }
  }
  class TixkitButton extends HTMLElement {
    connectedCallback() {
      setTimeout(() => this.dispatchEvent(new CustomEvent('loaded', { detail: { eventId: this.getAttribute('event') } })), 0);
    }
  }
  customElements.define('tixkit-widget', TixkitWidget);
  customElements.define('tixkit-button', TixkitButton);
`;

async function loadFixturePage(page: import('@playwright/test').Page, html: string): Promise<void> {
  // Mock the widget script
  await page.route('**/tixkit-widget.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: mockWidgetScript,
    }),
  );

  // Mock widget impression API
  await page.route('**/v1/public/events/**/widget-impressions', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ tracked: true, deduped: false }),
    }),
  );

  // Serve the fixture HTML
  await page.route('http://localhost:3201/embed-fixture', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: html,
    }),
  );

  await page.goto('http://localhost:3201/embed-fixture');
}

test.describe('embed generator fixture pages', () => {
  test('Webflow fixture page renders embed elements without secrets', async ({ page }) => {
    const html = readFixture('embed-webflow.html');
    await loadFixturePage(page, html);

    // Verify the widget element is present
    const widget = page.locator('tixkit-widget#tixkit-inline-evt_demo');
    await expect(widget).toBeAttached();
    await expect(widget).toHaveAttribute('brand', 'brd_demo');
    await expect(widget).toHaveAttribute('event', 'evt_demo');
    await expect(widget).toHaveAttribute('checkout-mode', 'inline');

    // Verify the button element is present
    const button = page.locator('tixkit-button#tixkit-button-evt_demo');
    await expect(button).toBeAttached();
    await expect(button).toHaveAttribute('checkout-mode', 'modal');
    await expect(button).toContainText('Buy tickets');

    // Verify the widget script tag is present
    const scriptTag = page.locator('script[src*="tixkit-widget.js"]');
    await expect(scriptTag).toHaveCount(1);

    // Verify no secret keys are in the page source
    const pageContent = await page.content();
    expect(pageContent).not.toContain('API_KEY');
    expect(pageContent).not.toContain('api_key');
    expect(pageContent).not.toContain('SECRET');
    expect(pageContent).not.toContain('sk_');
    expect(pageContent).not.toContain('whsec_');
  });

  test('Framer fixture page renders embed elements with theme and locale', async ({ page }) => {
    const html = readFixture('embed-framer.html');
    await loadFixturePage(page, html);

    const widget = page.locator('tixkit-widget#tixkit-modal-evt_demo');
    await expect(widget).toBeAttached();
    await expect(widget).toHaveAttribute('brand', 'brd_demo');
    await expect(widget).toHaveAttribute('event', 'evt_demo');
    await expect(widget).toHaveAttribute('checkout-mode', 'modal');
    await expect(widget).toHaveAttribute('theme', 'dark');
    await expect(widget).toHaveAttribute('locale', 'en');

    // Verify the widget script tag is present
    const scriptTag = page.locator('script[src*="tixkit-widget.js"]');
    await expect(scriptTag).toHaveCount(1);

    // Verify no secret keys
    const pageContent = await page.content();
    expect(pageContent).not.toContain('API_KEY');
    expect(pageContent).not.toContain('SECRET');
    expect(pageContent).not.toContain('sk_');
  });

  test('Webflow fixture dispatches lifecycle loaded event', async ({ page }) => {
    const html = readFixture('embed-webflow.html');
    await loadFixturePage(page, html);

    // The mock widget dispatches 'loaded' on connectedCallback
    // Verify the widget element got the loaded event by checking console output
    const consoleMessages: string[] = [];
    page.on('console', (msg) => consoleMessages.push(msg.text()));

    // Reload to trigger events
    await page.reload();
    await page.waitForTimeout(500);

    // The lifecycle listener should log 'Tixkit: loaded ...'
    const loadedLog = consoleMessages.find((m) => m.includes('Tixkit:') && m.includes('loaded'));
    expect(loadedLog).toBeTruthy();
  });
});
