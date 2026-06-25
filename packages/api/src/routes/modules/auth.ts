import type { FastifyPluginAsync } from 'fastify';

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request) => {
    const principal = request.principal!;
    return {
      ...principal,
      permissions: principal.scopes,
    };
  });
};
