import { describe, expect, it } from 'vitest';
import {
  adoptionPathsForRoute,
  canonicalDocRoutes,
  dashboardHelpRegistry,
  docRouteIds,
  docRoutes,
  filterHelpByPermissions,
  helpForPath,
  resolveDocUrl,
  workspaceReadinessReasonCodes,
  workspaceReadinessStepIds,
  sdkSnippetRegistry,
} from '../index.js';

describe('@tixkit/docs-core', () => {
  it('keeps route identifiers and canonical paths unique', () => {
    expect(new Set(docRouteIds).size).toBe(docRouteIds.length);
    expect(new Set(canonicalDocRoutes).size).toBe(canonicalDocRoutes.length);
    expect(canonicalDocRoutes.every((path) => path === '/' || /^\/[a-z0-9/-]+$/.test(path))).toBe(
      true,
    );
  });

  it('classifies legacy and shared guides into adoption paths deterministically', () => {
    expect(adoptionPathsForRoute('/operators/events')).toEqual(['sell']);
    expect(adoptionPathsForRoute('/developers/webhooks/setup')).toEqual(['platform']);
    expect(adoptionPathsForRoute('/self-hosting/production')).toEqual(['self-hosted']);
    expect(adoptionPathsForRoute('/reference/accessibility')).toEqual([
      'sell',
      'platform',
      'self-hosted',
    ]);
    expect(adoptionPathsForRoute('/contributing/testing')).toEqual([]);
    expect(adoptionPathsForRoute('/operators/events', ['platform'])).toEqual(['platform']);
  });

  it('resolves relative and absolute documentation URLs safely', () => {
    expect(resolveDocUrl('apiReference')).toBe('/reference/api');
    expect(resolveDocUrl('apiReference', 'https://docs.tixkit.com')).toBe(
      'https://docs.tixkit.com/reference/api',
    );
    expect(() => resolveDocUrl('apiReference', 'not a URL')).toThrow(
      'Invalid documentation origin',
    );
    expect(() => resolveDocUrl('apiReference', 'javascript:alert(1)')).toThrow(
      'must be an HTTP(S) origin',
    );
    expect(() => resolveDocUrl('apiReference', 'https://user:secret@docs.tixkit.com')).toThrow(
      'without credentials',
    );
    expect(() => resolveDocUrl('apiReference', 'https://docs.tixkit.com/base')).toThrow(
      'must not include a path',
    );
  });

  it('matches the most specific contextual help route', () => {
    expect(helpForPath('/events')).toMatchObject({ id: 'events' });
    expect(helpForPath('/events/evt_demo/tickets')).toMatchObject({
      id: 'event-tickets',
    });
    expect(helpForPath('/developer/webhooks/wh_demo')).toMatchObject({
      id: 'developer-webhooks',
    });
    expect(helpForPath('/unregistered')).toBeUndefined();
  });

  it('filters help entries by required permission', () => {
    const entries = filterHelpByPermissions(dashboardHelpRegistry, new Set(['events.read']));
    expect(entries.some((entry) => entry.id === 'events')).toBe(true);
    expect(entries.some((entry) => entry.id === 'developer-api-keys')).toBe(false);
  });

  it('references only existing documentation route IDs', () => {
    for (const entry of dashboardHelpRegistry) {
      expect(docRoutes[entry.docRouteId]).toBeTruthy();
      for (const task of entry.commonTasks) expect(docRoutes[task.docRouteId]).toBeTruthy();
      for (const item of entry.troubleshooting) expect(docRoutes[item.docRouteId]).toBeTruthy();
    }
  });

  it('keeps stable readiness identifiers and reason codes unique', () => {
    expect(workspaceReadinessStepIds).toEqual([
      'workspace_selection',
      'brand_identity',
      'payment_path',
      'team_access',
      'legal_configuration',
      'sender_identity',
    ]);
    expect(new Set(workspaceReadinessStepIds).size).toBe(workspaceReadinessStepIds.length);
    expect(new Set(workspaceReadinessReasonCodes).size).toBe(workspaceReadinessReasonCodes.length);
  });

  it('keeps SDK snippet identifiers, packages, demos, and guide routes complete', () => {
    expect(sdkSnippetRegistry).toHaveLength(12);
    expect(new Set(sdkSnippetRegistry.map((entry) => entry.id)).size).toBe(
      sdkSnippetRegistry.length,
    );
    for (const entry of sdkSnippetRegistry) {
      expect(entry.packageName).toBeTruthy();
      expect(entry.demoPath).toBeTruthy();
      expect(docRoutes[entry.docRouteId]).toBeTruthy();
      expect(entry.apiVersion).toBe('2026-08-02');
    }
  });
});
