/**
 * Zod validation schemas for admin table queries.
 *
 * Used by the API server to validate incoming query parameters.
 * Invalid filters fail with a typed 400 response listing rejected params.
 */

import { z } from 'zod';

export const adminTableSortSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(['asc', 'desc']),
});

export const adminTableFilterValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('select'), values: z.array(z.string().min(1)) }),
  z.object({ type: z.literal('boolean'), value: z.boolean() }),
  z.object({
    type: z.literal('date_range'),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
  z.object({
    type: z.literal('number_range'),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
]);

export const adminTableQuerySchema = z.object({
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().optional(),
  direction: z.enum(['next', 'prev']).optional(),
  search: z.string().optional(),
  sort: z.array(adminTableSortSchema).optional(),
  filters: z.record(z.string(), adminTableFilterValueSchema).optional(),
  includeTotal: z.boolean().optional(),
  includeFacets: z.boolean().optional(),
});

export type AdminTableQuerySchema = z.infer<typeof adminTableQuerySchema>;
