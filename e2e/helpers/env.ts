import path from 'node:path';

export const apiBaseUrl = withoutTrailingSlash(
  process.env.TIXKIT_API_URL ?? 'http://localhost:4200',
);

export const adminBaseUrl = withoutTrailingSlash(
  process.env.E2E_ADMIN_BASE_URL ?? process.env.ADMIN_DASHBOARD_URL ?? 'http://localhost:3001',
);

export const checkoutBaseUrl = withoutTrailingSlash(
  process.env.E2E_CHECKOUT_BASE_URL ?? process.env.CHECKOUT_URL ?? 'http://localhost:3000',
);

export const checkoutEventId = process.env.E2E_CHECKOUT_EVENT_ID ?? '';

export const widgetBundlePath = path.resolve(
  process.cwd(),
  process.env.E2E_WIDGET_BUNDLE ?? 'packages/widget/dist/tixkit-widget.js',
);

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
