import { describe, expect, it } from 'vitest';
import { sidebarData } from './nav';

describe('sidebarData permissions', () => {
  it('gates Check-in navigation with the scan permission', () => {
    const operateGroup = sidebarData.navGroups.find((group) => group.title === 'Operate');
    const checkInItem = operateGroup?.items.find((item) => item.title === 'Check-in');

    expect(checkInItem?.requiredPermission).toBe('checkins.write');
  });
});
