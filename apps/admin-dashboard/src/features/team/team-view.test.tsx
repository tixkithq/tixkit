import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOrganization, AdminTeamMember } from '@/lib/api';
import { TeamView } from './team-view';

const bootstrapState = vi.hoisted(() => ({
  organizations: [] as AdminOrganization[],
  organizationId: undefined as string | undefined,
  brands: [] as Array<{ id: string; organizationId: string; name: string }>,
  loading: false,
  error: null as string | null,
}));

const adminApiMock = vi.hoisted(() => ({
  listTeamMembers: vi.fn(),
  inviteTeamMember: vi.fn(),
  updateTeamMember: vi.fn(),
}));
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const eventsState = vi.hoisted(() => ({
  events: [
    { id: 'evt_1', title: 'Launch Night' },
    { id: 'evt_2', title: 'Second Night' },
  ],
  loading: false,
}));

if (typeof window === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
  });
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => bootstrapState,
}));

vi.mock('@/hooks/use-all-events', () => ({
  useAllEvents: () => ({ ...eventsState, error: undefined, refetch: vi.fn() }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    adminApi: adminApiMock,
  };
});

vi.mock('sonner', () => ({
  toast: toastMock,
}));

const organization: AdminOrganization = {
  id: 'org_1',
  tenantId: 'tnt_1',
  name: 'Main Workspace',
  slug: 'main-workspace',
  status: 'active',
  boxOfficeSettings: {
    enabled: true,
    allowedTenderTypes: ['cash', 'manual_card', 'comp'],
    requireBuyerEmail: false,
    receiptMode: 'email',
  },
};

function makeMember(overrides: Partial<AdminTeamMember> = {}): AdminTeamMember {
  return {
    id: 'mem_1',
    organizationId: organization.id,
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    role: 'admin',
    status: 'active',
    joinedAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/settings/members');
  document.body.innerHTML = '';
  bootstrapState.organizations = [organization];
  bootstrapState.organizationId = organization.id;
  bootstrapState.loading = false;
  bootstrapState.error = null;
  bootstrapState.brands = [];
  adminApiMock.listTeamMembers.mockReset();
  adminApiMock.inviteTeamMember.mockReset();
  adminApiMock.updateTeamMember.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

describe('TeamView', () => {
  it('opens an event-scoped kiosk invitation and reports local capture honestly', async () => {
    window.history.replaceState(
      {},
      '',
      '/settings/members?invite=1&eventId=evt_1&eventName=Launch+Night&returnTo=%2Fkiosk%2Fevt_1%3Ftab%3Dscan',
    );
    adminApiMock.listTeamMembers.mockResolvedValue({ ok: true, data: [] });
    adminApiMock.inviteTeamMember.mockResolvedValue({
      ok: true,
      data: makeMember({
        email: 'door@example.com',
        role: 'door_staff',
        status: 'invited',
        eventIds: ['evt_1'],
        invitationDelivery: 'captured',
        invitationProvider: 'capture',
      }),
    });

    render(React.createElement(TeamView));
    expect(
      await screen.findByRole('heading', { name: 'Invite staff to Launch Night' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Selected events')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('combobox')[1]!);
    expect(await screen.findByText('All events in this workspace')).toBeInTheDocument();
    const selectedEventsLabels = screen.getAllByText('Selected events');
    expect(selectedEventsLabels.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(selectedEventsLabels.at(-1)!);
    expect(screen.getByRole('button', { name: /selected: launch night/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /selected: launch night/i }));
    fireEvent.click(await screen.findByText('Second Night'));
    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'door@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invitation' }));

    await waitFor(() =>
      expect(adminApiMock.inviteTeamMember).toHaveBeenCalledWith(organization.id, {
        email: 'door@example.com',
        role: 'door_staff',
        eventIds: ['evt_1', 'evt_2'],
        returnTo: '/kiosk/evt_1?tab=scan',
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('captured locally'));
  });

  it('upserts a resent pending invitation instead of rendering a duplicate member', async () => {
    const pending = makeMember({
      id: 'mem_pending',
      email: 'pending@example.com',
      name: 'Pending Staff',
      role: 'door_staff',
      status: 'invited',
    });
    adminApiMock.listTeamMembers.mockResolvedValue({ ok: true, data: [pending] });
    adminApiMock.inviteTeamMember.mockResolvedValue({
      ok: true,
      data: { ...pending, invitationDelivery: 'captured', invitationProvider: 'capture' },
    });

    render(React.createElement(TeamView));
    await screen.findByText('pending@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Invite member' }));
    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'pending@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invitation' }));

    await waitFor(() => expect(adminApiMock.inviteTeamMember).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText('pending@example.com')).toHaveLength(1);
  });

  it('wraps long member identity text without squeezing role and status controls', async () => {
    const longName =
      'Alexandria Catherine Montgomery-Worthington International Operations Administrator';
    const longEmail =
      'alexandria.catherine.montgomery-worthington.with.a.very.long.email@example-subdomain-with-long-name.test';
    adminApiMock.listTeamMembers.mockResolvedValue({
      ok: true,
      data: [
        makeMember({
          name: longName,
          email: longEmail,
          role: 'owner',
          status: 'invited',
        }),
      ],
    });

    const { container } = render(React.createElement(TeamView));

    await waitFor(() => expect(adminApiMock.listTeamMembers).toHaveBeenCalledWith(organization.id));

    expect(screen.getByText(longName)).toHaveClass('break-words');
    expect(screen.getByText(longEmail)).toHaveClass('break-all');
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('invited')).toHaveClass('shrink-0');
    expect(
      container.querySelector('.flex-col.items-start.justify-between.gap-3'),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('.min-w-0').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button', { name: /change role/i })).not.toBeInTheDocument();
  });

  it('updates an existing member role through the change-role dialog', async () => {
    adminApiMock.listTeamMembers.mockResolvedValue({
      ok: true,
      data: [makeMember({ role: 'viewer', status: 'active' })],
    });
    adminApiMock.updateTeamMember.mockResolvedValue({
      ok: true,
      data: makeMember({ role: 'door_staff_sales', status: 'active' }),
    });

    render(React.createElement(TeamView));

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /change role for ada lovelace/i }));
    expect(screen.getByRole('heading', { name: 'Change role' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save role/i }));

    await waitFor(() =>
      expect(adminApiMock.updateTeamMember).toHaveBeenCalledWith(organization.id, 'mem_1', {
        role: 'viewer',
      }),
    );
    await waitFor(() => expect(screen.getByText('Door staff + sales')).toBeInTheDocument());
  });

  it('preserves an existing event-scoped member when their role is saved', async () => {
    const scopedMember = makeMember({
      id: 'mem_scoped',
      role: 'door_staff',
      status: 'active',
      eventIds: ['evt_1', 'evt_2'],
    });
    adminApiMock.listTeamMembers.mockResolvedValue({ ok: true, data: [scopedMember] });
    adminApiMock.updateTeamMember.mockResolvedValue({ ok: true, data: scopedMember });

    render(React.createElement(TeamView));
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: /change role for ada lovelace/i }));

    expect(screen.getByText('Selected events')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /selected: launch night, second night/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save role' }));

    await waitFor(() =>
      expect(adminApiMock.updateTeamMember).toHaveBeenCalledWith(organization.id, 'mem_scoped', {
        role: 'door_staff',
        eventIds: ['evt_1', 'evt_2'],
      }),
    );
  });

  it('keeps the member unchanged and surfaces a rejected role change', async () => {
    adminApiMock.listTeamMembers.mockResolvedValue({
      ok: true,
      data: [makeMember({ role: 'viewer', status: 'active' })],
    });
    adminApiMock.updateTeamMember.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Owner role cannot be changed', status: 403 },
    });

    render(React.createElement(TeamView));

    await waitFor(() => expect(adminApiMock.listTeamMembers).toHaveBeenCalledWith(organization.id));
    fireEvent.click(screen.getByRole('button', { name: /change role for ada lovelace/i }));
    fireEvent.click(screen.getByRole('button', { name: /save role/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('Owner role cannot be changed'),
    );
    expect(screen.getByRole('heading', { name: 'Change role' })).toBeInTheDocument();
    expect(screen.getAllByText('Viewer')).not.toHaveLength(0);
  });
});
