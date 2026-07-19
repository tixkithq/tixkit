import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EventsPage from './events/page';
import OrdersPage from './orders/page';
import OrderDetailPage from './orders/[orderId]/page';
import AttendeesPage from './attendees/page';
import CheckInPage from './check-in/page';
import ReportsPage from './reports/page';
import EventAttendeesPage from './events/[eventId]/attendees/page';
import EventCheckInPage from './events/[eventId]/check-in/page';
import EventReportsPage from './events/[eventId]/reports/page';
import EventSettingsPage from './events/[eventId]/settings/page';

const routeMocks = vi.hoisted(() => ({
  permissionGuard: vi.fn(),
  eventsTable: vi.fn(),
  paymentCompensationsPanel: vi.fn(),
  ordersTable: vi.fn(),
  orderDetailView: vi.fn(),
  attendeesTable: vi.fn(),
  checkInConsole: vi.fn(),
  reportsView: vi.fn(),
  eventAttendeesView: vi.fn(),
  eventReportsView: vi.fn(),
  eventSettingsView: vi.fn(),
}));

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({
    required,
    anyOf,
    children,
  }: {
    required?: string;
    anyOf?: readonly string[];
    children: React.ReactNode;
  }) => {
    const requirement = required ?? anyOf;
    routeMocks.permissionGuard(requirement);
    return (
      <section data-testid={`permission-guard-${required ?? anyOf?.join(',')}`}>{children}</section>
    );
  },
}));

vi.mock('@/features/events/events-table', () => ({
  EventsTable: () => {
    routeMocks.eventsTable();
    return <div data-testid="events-table" />;
  },
}));

vi.mock('@/features/orders/payment-compensations-panel', () => ({
  PaymentCompensationsPanel: () => {
    routeMocks.paymentCompensationsPanel();
    return <div data-testid="payment-compensations-panel" />;
  },
}));

vi.mock('@/features/orders/orders-table', () => ({
  OrdersTable: () => {
    routeMocks.ordersTable();
    return <div data-testid="orders-table" />;
  },
}));

vi.mock('@/features/orders/order-detail-view', () => ({
  OrderDetailView: ({ orderId }: { orderId: string }) => {
    routeMocks.orderDetailView(orderId);
    return <div data-testid="order-detail-view" />;
  },
}));

vi.mock('@/features/attendees/attendees-table', () => ({
  AttendeesTable: () => {
    routeMocks.attendeesTable();
    return <div data-testid="attendees-table" />;
  },
}));

vi.mock('@/features/kiosk/check-in-console', () => ({
  CheckInConsole: (props: { mode?: string; initialEventId?: string; lockEvent?: boolean }) => {
    routeMocks.checkInConsole(props);
    return <div data-testid="check-in-console" />;
  },
}));

vi.mock('@/features/reports/reports-view', () => ({
  ReportsView: ({ eventId }: { eventId?: string }) => {
    routeMocks.reportsView(eventId);
    return <div data-testid="reports-view" />;
  },
}));

vi.mock('@/features/events/event-attendees-view', () => ({
  EventAttendeesView: ({ eventId }: { eventId: string }) => {
    routeMocks.eventAttendeesView(eventId);
    return <div data-testid="event-attendees-view" />;
  },
}));

vi.mock('@/features/events/event-reports-view', () => ({
  EventReportsView: ({ eventId }: { eventId: string }) => {
    routeMocks.eventReportsView(eventId);
    return <div data-testid="event-reports-view" />;
  },
}));

vi.mock('@/features/events/event-settings-view', () => ({
  EventSettingsView: ({ eventId }: { eventId: string }) => {
    routeMocks.eventSettingsView(eventId);
    return <div data-testid="event-settings-view" />;
  },
}));

describe('core dashboard route permission guards', () => {
  beforeEach(() => {
    for (const mock of Object.values(routeMocks)) {
      mock.mockClear();
    }
  });

  it('guards global Events, Orders, Attendees, Check-in, and Reports routes', async () => {
    const events = render(<EventsPage />);
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('events.read');
    expect(routeMocks.eventsTable).toHaveBeenCalledTimes(1);
    expect(events.getByTestId('permission-guard-events.read')).toBeInTheDocument();
    events.unmount();

    const orders = render(<OrdersPage />);
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('orders.read');
    expect(routeMocks.paymentCompensationsPanel).toHaveBeenCalledTimes(1);
    expect(routeMocks.ordersTable).toHaveBeenCalledTimes(1);
    expect(orders.getByTestId('permission-guard-orders.read')).toBeInTheDocument();
    orders.unmount();

    const attendees = render(<AttendeesPage />);
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('attendees.read');
    expect(routeMocks.attendeesTable).toHaveBeenCalledTimes(1);
    expect(attendees.getByTestId('permission-guard-attendees.read')).toBeInTheDocument();
    attendees.unmount();

    const checkInElement = await CheckInPage({});
    const checkIn = render(checkInElement);
    const checkInPermissions = [
      'checkins.write',
      'checkins.read',
      'box_office.write',
      'orders.write',
    ];
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith(checkInPermissions);
    expect(routeMocks.checkInConsole).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'embedded' }),
    );
    expect(
      checkIn.getByTestId(`permission-guard-${checkInPermissions.join(',')}`),
    ).toBeInTheDocument();
    checkIn.unmount();

    const reports = render(<ReportsPage />);
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('reports.read');
    expect(routeMocks.reportsView).toHaveBeenCalledWith(undefined);
    expect(reports.getByTestId('permission-guard-reports.read')).toBeInTheDocument();
  });

  it('guards order detail and event-scoped dashboard routes', async () => {
    const orderDetailElement = await OrderDetailPage({
      params: Promise.resolve({ orderId: 'ord_1' }),
    });
    const orderDetail = render(orderDetailElement);
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('orders.read');
    expect(routeMocks.orderDetailView).toHaveBeenCalledWith('ord_1');
    expect(orderDetail.getByTestId('permission-guard-orders.read')).toBeInTheDocument();
    orderDetail.unmount();

    const eventAttendeesElement = await EventAttendeesPage({
      params: Promise.resolve({ eventId: 'evt_1' }),
    });
    const eventAttendees = render(eventAttendeesElement);
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('attendees.read');
    expect(routeMocks.eventAttendeesView).toHaveBeenCalledWith('evt_1');
    expect(eventAttendees.getByTestId('permission-guard-attendees.read')).toBeInTheDocument();
    eventAttendees.unmount();

    const eventCheckInElement = await EventCheckInPage({
      params: Promise.resolve({ eventId: 'evt_1' }),
    });
    const eventCheckIn = render(eventCheckInElement);
    const checkInPermissions = [
      'checkins.write',
      'checkins.read',
      'box_office.write',
      'orders.write',
    ];
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith(checkInPermissions);
    expect(routeMocks.checkInConsole).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'embedded',
        lockEvent: true,
        initialEventId: 'evt_1',
      }),
    );
    expect(
      eventCheckIn.getByTestId(`permission-guard-${checkInPermissions.join(',')}`),
    ).toBeInTheDocument();
    eventCheckIn.unmount();

    const eventReportsElement = await EventReportsPage({
      params: Promise.resolve({ eventId: 'evt_1' }),
    });
    const eventReports = render(eventReportsElement);
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('reports.read');
    expect(routeMocks.eventReportsView).toHaveBeenCalledWith('evt_1');
    expect(eventReports.getByTestId('permission-guard-reports.read')).toBeInTheDocument();
    eventReports.unmount();

    const eventSettingsElement = await EventSettingsPage({
      params: Promise.resolve({ eventId: 'evt_1' }),
    });
    const eventSettings = render(eventSettingsElement);
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('events.write');
    expect(routeMocks.eventSettingsView).toHaveBeenCalledWith('evt_1');
    expect(eventSettings.getByTestId('permission-guard-events.write')).toBeInTheDocument();
  });
});
