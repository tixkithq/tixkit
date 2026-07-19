import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TicketsPage from './events/[eventId]/tickets/page';
import ProductsPage from './events/[eventId]/products/page';
import CheckoutFormPage from './events/[eventId]/checkout-form/page';
import EmbedPage from './events/[eventId]/distribution/embed/page';
import PreviewPage from './events/[eventId]/preview/page';
import SchedulePage from './events/[eventId]/schedule/page';
import MarketingPage from './events/[eventId]/marketing/page';

const routeMocks = vi.hoisted(() => ({
  permissionGuard: vi.fn(),
  renderedView: vi.fn(),
}));

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({ required, children }: { required: string; children: React.ReactNode }) => {
    routeMocks.permissionGuard(required);
    return <section data-testid={`permission-guard-${required}`}>{children}</section>;
  },
}));

vi.mock('@/features/events/event-tickets-view', () => ({
  EventTicketsView: ({ eventId }: { eventId: string }) => {
    routeMocks.renderedView('tickets', eventId);
    return <div />;
  },
}));
vi.mock('@/features/events/event-products-view', () => ({
  EventProductsView: ({ eventId }: { eventId: string }) => {
    routeMocks.renderedView('products', eventId);
    return <div />;
  },
}));
vi.mock('@/features/events/event-checkout-form-view', () => ({
  EventCheckoutFormView: ({ eventId }: { eventId: string }) => {
    routeMocks.renderedView('checkout-form', eventId);
    return <div />;
  },
}));
vi.mock('@/features/events/embed-studio', () => ({
  EmbedStudio: ({ eventId }: { eventId: string }) => {
    routeMocks.renderedView('embed', eventId);
    return <div />;
  },
}));
vi.mock('@/features/events/event-preview-view', () => ({
  EventPreviewView: ({ eventId }: { eventId: string }) => {
    routeMocks.renderedView('preview', eventId);
    return <div />;
  },
}));
vi.mock('@/features/events/event-schedule-view', () => ({
  EventScheduleView: ({ eventId }: { eventId: string }) => {
    routeMocks.renderedView('schedule', eventId);
    return <div />;
  },
}));
vi.mock('@/features/events/event-marketing-view', () => ({
  EventMarketingView: ({ eventId }: { eventId: string }) => {
    routeMocks.renderedView('marketing', eventId);
    return <div />;
  },
}));

describe('event mutation route permission guards', () => {
  beforeEach(() => {
    routeMocks.permissionGuard.mockClear();
    routeMocks.renderedView.mockClear();
  });

  it.each([
    ['tickets', TicketsPage],
    ['products', ProductsPage],
  ] as const)('guards the %s route with tickets.write', async (viewName, Page) => {
    const element = await Page({ params: Promise.resolve({ eventId: 'evt_1' }) });
    const page = render(element);

    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('tickets.write');
    expect(routeMocks.renderedView).toHaveBeenCalledWith(viewName, 'evt_1');
    expect(page.getByTestId('permission-guard-tickets.write')).toBeInTheDocument();
  });

  it.each([
    ['checkout-form', CheckoutFormPage],
    ['preview', PreviewPage],
    ['schedule', SchedulePage],
    ['marketing', MarketingPage],
  ] as const)('guards the %s route with events.write', async (viewName, Page) => {
    const element = await Page({ params: Promise.resolve({ eventId: 'evt_1' }) });
    const page = render(element);

    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('events.write');
    expect(routeMocks.renderedView).toHaveBeenCalledWith(viewName, 'evt_1');
    expect(page.getByTestId('permission-guard-events.write')).toBeInTheDocument();
  });

  it('keeps the read-only embed studio available behind events.read', async () => {
    const element = await EmbedPage({ params: Promise.resolve({ eventId: 'evt_1' }) });
    const page = render(element);

    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('events.read');
    expect(routeMocks.renderedView).toHaveBeenCalledWith('embed', 'evt_1');
    expect(page.getByTestId('permission-guard-events.read')).toBeInTheDocument();
  });
});
