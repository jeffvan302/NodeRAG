export interface VisionDispatchEstimate {
  readonly estimatedImages: number;
  readonly imagesPerCall: number;
  readonly parallelCalls: number;
  readonly estimatedBatches: number;
  readonly estimatedParallelWaves: number;
  readonly provisionalElapsedMs: number | null;
}

export const calculateVisionDispatchEstimate = (
  estimatedImages: number,
  imagesPerCall: number,
  parallelCalls: number,
  averageCallMs: number | null,
): VisionDispatchEstimate => {
  const images = Math.max(0, Math.floor(estimatedImages));
  const batchSize = Math.max(1, Math.floor(imagesPerCall));
  const concurrency = Math.max(1, Math.floor(parallelCalls));
  const batches = Math.ceil(images / batchSize);
  const waves = Math.ceil(batches / concurrency);
  return {
    estimatedImages: images,
    imagesPerCall: batchSize,
    parallelCalls: concurrency,
    estimatedBatches: batches,
    estimatedParallelWaves: waves,
    provisionalElapsedMs: averageCallMs === null ? null : Math.max(0, averageCallMs) * waves,
  };
};
