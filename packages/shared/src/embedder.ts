import { z } from 'zod';

export const embedderModelSchema = z.object({
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  dimensions: z.number().int().min(1).max(65_535),
});

export type EmbedderModel = z.infer<typeof embedderModelSchema>;

export const embedderRequestSchema = z.discriminatedUnion('operation', [
  z.object({
    id: z.string().uuid(),
    operation: z.literal('embed'),
    priority: z.number().int().min(0).max(9),
    texts: z.array(z.string().min(1)).min(1).max(16),
    maxTokens: z.number().int().min(1).max(32_768),
    model: embedderModelSchema.optional(),
  }),
  z.object({
    id: z.string().uuid(),
    operation: z.literal('count'),
    priority: z.number().int().min(0).max(9),
    texts: z.array(z.string()).min(1).max(16),
    model: embedderModelSchema.optional(),
  }),
]);

export type EmbedderRequest = z.infer<typeof embedderRequestSchema>;

export const embedderResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    id: z.string().uuid(),
    ok: z.literal(true),
    vectors: z.array(z.array(z.number())),
    tokenCounts: z.array(z.number().int().nonnegative()),
    elapsedMilliseconds: z.number().nonnegative(),
  }),
  z.object({
    id: z.string().uuid(),
    ok: z.literal(false),
    code: z.string(),
  }),
]);

export type EmbedderResponse = z.infer<typeof embedderResponseSchema>;

export interface EmbeddingBatch {
  readonly vectors: readonly (readonly number[])[];
  readonly tokenCounts: readonly number[];
  readonly elapsedMilliseconds: number;
}

export interface Embedder {
  embed(
    texts: readonly string[],
    maxTokens: number,
    priority?: number,
    model?: EmbedderModel,
  ): Promise<EmbeddingBatch>;
  countTokens(
    texts: readonly string[],
    priority?: number,
    model?: EmbedderModel,
  ): Promise<readonly number[]>;
}
