import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EventSettingsPage from './page';

const mocks = vi.hoisted(() => ({
  eventSettingsView: vi.fn(),
  usePermissions: vi.fn(),
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: mocks.usePermissions,
}));

vi.mock('@/features/events/event-settings-view', () => ({
  EventSettingsView: ({ eventId }: { eventId: string }) => {
    mocks.eventSettingsView(eventId);
    return <div data-testid="event-settings-view" />;
  },
}));

describe('EventSettingsPage permission containment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['permission loading', true, null],
    ['write permission denied', false, null],
    ['permission lookup failed', false, 'permission service unavailable'],
  ])('does not mount autosaving settings while %s', async (_label, loading, error) => {
    mocks.usePermissions.mockReturnValue({
      can: vi.fn(() => false),
      loading,
      error,
    });

    const page = await EventSettingsPage({ params: Promise.resolve({ eventId: 'evt_1' }) });
    render(page);

    expect(mocks.eventSettingsView).not.toHaveBeenCalled();
    expect(screen.queryByTestId('event-settings-view')).not.toBeInTheDocument();
  });

  it('mounts settings only after events.write is granted', async () => {
    const can = vi.fn((permission: string) => permission === 'events.write');
    mocks.usePermissions.mockReturnValue({ can, loading: false, error: null });

    const page = await EventSettingsPage({ params: Promise.resolve({ eventId: 'evt_1' }) });
    render(page);

    expect(can).toHaveBeenCalledWith('events.write');
    expect(mocks.eventSettingsView).toHaveBeenCalledWith('evt_1');
    expect(screen.getByTestId('event-settings-view')).toBeInTheDocument();
  });
});
