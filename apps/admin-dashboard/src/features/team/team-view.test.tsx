import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOrganization, AdminTeamMember } from '@/lib/api';
import { TeamView } from './team-view';

const bootstrapState = vi.hoisted(() => ({
  organizations: [] as AdminOrganization[],
  organizationId: undefined as string | undefined,
  loading: false,
  error: null as string | null,
}));

const adminApiMock = vi.hoisted(() => ({
  listTeamMembers: vi.fn(),
  inviteTeamMember: vi.fn(),
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

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => bootstrapState,
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    adminApi: adminApiMock,
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
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
  document.body.innerHTML = '';
  bootstrapState.organizations = [organization];
  bootstrapState.organizationId = organization.id;
  bootstrapState.loading = false;
  bootstrapState.error = null;
  adminApiMock.listTeamMembers.mockReset();
  adminApiMock.inviteTeamMember.mockReset();
});

describe('TeamView', () => {
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
  });
});
