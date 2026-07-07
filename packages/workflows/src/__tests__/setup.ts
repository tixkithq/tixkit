import { afterEach } from 'vitest';

afterEach(async () => {
  const { closeActivityClients } = await import('../activities/activity-clients.js');
  await closeActivityClients();
});
