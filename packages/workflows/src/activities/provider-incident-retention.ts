import { ProviderIncidentEvidenceRepository } from '@tixkit/db';
import { getActivityDb } from './activity-clients.js';

const PROVIDER_INCIDENT_RETENTION_BATCH_SIZE = 100;

export async function eraseExpiredProviderIncidentEvidenceActivity(): Promise<{
  erasedCount: number;
}> {
  const erasedCount = await new ProviderIncidentEvidenceRepository(getActivityDb()).sweepExpired(
    new Date(),
    PROVIDER_INCIDENT_RETENTION_BATCH_SIZE,
  );
  return { erasedCount };
}
