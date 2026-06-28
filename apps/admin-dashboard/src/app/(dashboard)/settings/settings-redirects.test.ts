import { redirect } from 'next/navigation';
import { describe, expect, it, vi } from 'vitest';

import OrganizationSettingsRedirect from './organization/page';
import TeamSettingsRedirect from './team/page';

describe('settings legacy route redirects', () => {
  it('redirects old organization settings URL to workspace settings', () => {
    OrganizationSettingsRedirect();

    expect(vi.mocked(redirect)).toHaveBeenCalledWith('/settings/workspace');
  });

  it('redirects old team settings URL to members settings', () => {
    TeamSettingsRedirect();

    expect(vi.mocked(redirect)).toHaveBeenCalledWith('/settings/members');
  });
});
