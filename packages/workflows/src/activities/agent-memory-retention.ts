import { AgentMemoryRepository } from '@tixkit/db';
import { getActivityDb } from './activity-clients.js';

const AGENT_MEMORY_RETENTION_BATCH_SIZE = 100;

export async function eraseExpiredAgentMemoryActivity(): Promise<{ erasedCount: number }> {
  const erasedCount = await new AgentMemoryRepository(getActivityDb()).sweepExpired(
    AGENT_MEMORY_RETENTION_BATCH_SIZE,
  );
  return { erasedCount };
}
