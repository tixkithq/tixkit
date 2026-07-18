import { describe, expect, it } from 'vitest';
import { selectCampaignProviderRoute } from '../routes/modules/messaging.js';

describe('message campaign provider routing', () => {
  it('selects only a route explicitly authorized for the campaign category', () => {
    const transactional = {
      id: 'route_transactional',
      allowed_categories: JSON.stringify(['transactional']),
    };
    const bulk = {
      id: 'route_bulk',
      allowed_categories: JSON.stringify(['bulk']),
    };

    expect(selectCampaignProviderRoute([transactional, bulk], 'bulk')).toBe(bulk);
    expect(selectCampaignProviderRoute([transactional], 'bulk')).toBeUndefined();
  });

  it('fails closed for malformed or non-array category metadata', () => {
    expect(
      selectCampaignProviderRoute(
        [
          { id: 'route_malformed', allowed_categories: '{' },
          { id: 'route_object', allowed_categories: JSON.stringify({ bulk: true }) },
          { id: 'route_null', allowed_categories: null },
        ],
        'bulk',
      ),
    ).toBeUndefined();
  });
});
