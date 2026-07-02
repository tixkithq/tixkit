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

const routeMocks = vi.hoisted(() => ({
  permissionGuard: vi.fn(),
  eventsTable: vi.fn(),
  paymentCompensationsPanel: vi.fn(),
  ordersTable: vi.fn(),
  orderDetailView: vi.fn(),
  attendeesTable: vi.fn(),
  checkInView: vi.fn(),
  reportsView: vi.fn(),
  eventAttendeesView: vi.fn(),
  eventCheckInView: vi.fn(),
  eventReportsView: vi.fn(),
}));

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({ required, children }: { required: string; children: React.ReactNode }) => {
    routeMocks.permissionGuard(required);
    return <section data-testid={`permission-guard-${required}`}>{children}</section>;
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

vi.mock('@/features/check-in/scan-view', () => ({
  CheckInView: () => {
    routeMocks.checkInView();
    return <div data-testid="check-in-view" />;
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

vi.mock('@/features/events/event-check-in-view', () => ({
  EventCheckInView: ({ eventId }: { eventId: string }) => {
    routeMocks.eventCheckInView(eventId);
    return <div data-testid="event-check-in-view" />;
  },
}));

vi.mock('@/features/events/event-reports-view', () => ({
  EventReportsView: ({ eventId }: { eventId: string }) => {
    routeMocks.eventReportsView(eventId);
    return <div data-testid="event-reports-view" />;
  },
}));

describe('core dashboard route permission guards', () => {
  beforeEach(() => {
    for (const mock of Object.values(routeMocks)) {
      mock.mockClear();
    }
  });

  it('guards global Events, Orders, Attendees, Check-in, and Reports routes', () => {
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

    const checkIn = render(<CheckInPage />);
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('checkins.write');
    expect(routeMocks.checkInView).toHaveBeenCalledTimes(1);
    expect(checkIn.getByTestId('permission-guard-checkins.write')).toBeInTheDocument();
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
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('checkins.write');
    expect(routeMocks.eventCheckInView).toHaveBeenCalledWith('evt_1');
    expect(eventCheckIn.getByTestId('permission-guard-checkins.write')).toBeInTheDocument();
    eventCheckIn.unmount();

    const eventReportsElement = await EventReportsPage({
      params: Promise.resolve({ eventId: 'evt_1' }),
    });
    const eventReports = render(eventReportsElement);
    expect(routeMocks.permissionGuard).toHaveBeenLastCalledWith('reports.read');
    expect(routeMocks.eventReportsView).toHaveBeenCalledWith('evt_1');
    expect(eventReports.getByTestId('permission-guard-reports.read')).toBeInTheDocument();
  });
});
