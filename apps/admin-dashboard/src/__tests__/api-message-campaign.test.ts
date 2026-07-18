import { describe, expect, it } from 'vitest';
import { normalizeMessageCampaign } from '../lib/api';

describe('message campaign API normalization', () => {
  it('uses the queued campaignId and preserves workflow start failures', () => {
    const campaign = normalizeMessageCampaign({
      campaignId: 'campaign_1',
      eventId: 'event_1',
      emailTemplateKey: 'event-update',
      channel: 'email',
      status: 'failed',
      queuedEmailJobs: 0,
      queuedSmsJobs: 0,
      startFailedEmailJobs: 2,
      startFailedSmsJobs: 0,
    });

    expect(campaign).toMatchObject({
      id: 'campaign_1',
      eventId: 'event_1',
      status: 'failed',
      failedCount: 2,
      queuedCount: 0,
    });
  });

  it('retains persisted campaign ids when normalizing list responses', () => {
    const campaign = normalizeMessageCampaign({
      id: 'campaign_persisted',
      eventId: 'event_1',
      channel: 'sms',
      status: 'queued',
    });

    expect(campaign.id).toBe('campaign_persisted');
  });
});
