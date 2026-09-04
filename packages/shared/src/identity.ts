import { z } from 'zod';

export const siloCapabilitySchema = z.enum(['read', 'upload', 'delete']);
export type SiloCapability = z.infer<typeof siloCapabilitySchema>;

export const siloActionSchema = z.enum([
  'list_silos',
  'search',
  'read_chunk',
  'read_markdown',
  'download_original',
  'upload',
  'configure_source',
  'reindex',
  'delete',
]);
export type SiloAction = z.infer<typeof siloActionSchema>;

export const readinessStateSchema = z.enum([
  'unconfigured',
  'initializing',
  'operational',
  'maintenance',
  'upgrade_required',
  'database_ahead',
  'degraded',
  'unavailable',
]);
export type ReadinessState = z.infer<typeof readinessStateSchema>;

export const documentStateSchema = z.enum([
  'pending',
  'extracting',
  'awaiting_vision',
  'ready',
  'source_missing',
  'failed',
  'purging',
]);
export type DocumentState = z.infer<typeof documentStateSchema>;

export const jobStateSchema = z.enum([
  'pending',
  'leased',
  'retry_wait',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
]);
export type JobState = z.infer<typeof jobStateSchema>;

export const actionCapability: Readonly<Record<SiloAction, SiloCapability | 'any'>> = {
  list_silos: 'any',
  search: 'read',
  read_chunk: 'read',
  read_markdown: 'read',
  download_original: 'read',
  upload: 'upload',
  configure_source: 'upload',
  reindex: 'upload',
  delete: 'delete',
};

export const searchOnlyAllowedActions: ReadonlySet<SiloAction> = new Set([
  'list_silos',
  'search',
  'read_chunk',
]);
