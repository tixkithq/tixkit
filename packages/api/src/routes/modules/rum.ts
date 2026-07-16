import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  observeRumWebVital,
  RUM_MAXIMUM_VALUES,
  RUM_SCHEMA_VERSION,
  RUM_SURFACES,
} from '@tixkit/shared';
import { parseBody } from '../../http/schemas.js';

export const RUM_JSON_BODY_LIMIT_BYTES = 512;
export const RUM_RATE_LIMIT_PER_MINUTE = 60;

const common = {
  schemaVersion: z.literal(RUM_SCHEMA_VERSION),
  surface: z.enum(RUM_SURFACES),
};

const rumSampleSchema = z.discriminatedUnion('metric', [
  z
    .object({
      ...common,
      metric: z.literal('LCP'),
      value: z.number().finite().min(0).max(RUM_MAXIMUM_VALUES.LCP),
    })
    .strict(),
  z
    .object({
      ...common,
      metric: z.literal('INP'),
      value: z.number().finite().min(0).max(RUM_MAXIMUM_VALUES.INP),
    })
    .strict(),
  z
    .object({
      ...common,
      metric: z.literal('CLS'),
      value: z.number().finite().min(0).max(RUM_MAXIMUM_VALUES.CLS),
    })
    .strict(),
]);

export const rumRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/public/rum',
    {
      bodyLimit: RUM_JSON_BODY_LIMIT_BYTES,
      config: {
        rateLimit: {
          max: RUM_RATE_LIMIT_PER_MINUTE,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const sample = parseBody(rumSampleSchema, request.body);
      observeRumWebVital(app.observability.metrics, {
        surface: sample.surface,
        metric: sample.metric,
        value: sample.value,
      });
      return reply.status(202).send({ accepted: true });
    },
  );
};
