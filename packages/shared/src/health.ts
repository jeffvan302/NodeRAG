import { z } from 'zod';
import { readinessStateSchema } from './identity.js';

export const serviceStateSchema = z.enum(['ok', 'degraded', 'unavailable']);

export const healthResponseSchema = z.object({
  service: z.literal('noderag'),
  status: z.literal('ok'),
  version: z.string().min(1),
});

export const readinessResponseSchema = z.object({
  service: z.literal('noderag'),
  status: serviceStateSchema,
  state: readinessStateSchema,
  migrationHead: z.string().nullable(),
  expectedMigrationHead: z.string().min(1),
  reasons: z.array(z.string()),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
