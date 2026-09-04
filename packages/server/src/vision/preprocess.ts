import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export interface VisionPreprocessOptions {
  readonly maximumDimension: number;
  readonly minimumDimension?: number;
  readonly maximumAspectRatio?: number;
  readonly minimumEntropy?: number;
}

export interface PreparedVisionImage {
  readonly disposition: 'ready';
  readonly bytes: Uint8Array;
  readonly mediaType: 'image/png';
  readonly originalSha256: string;
  readonly preprocessedSha256: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly entropy: number;
}

export interface SkippedVisionImage {
  readonly disposition: 'skipped';
  readonly originalSha256: string;
  readonly width: number;
  readonly height: number;
  readonly entropy: number;
  readonly reason: 'too-small' | 'extreme-aspect-ratio' | 'low-entropy';
}

export type VisionPreprocessResult = PreparedVisionImage | SkippedVisionImage;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const imageEntropy = (pixels: Uint8ClampedArray): number => {
  const histogram = new Uint32Array(256);
  let samples = 0;
  for (let index = 0; index + 3 < pixels.length; index += 16) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    const luminance = Math.max(
      0,
      Math.min(255, Math.round(red * 0.299 + green * 0.587 + blue * 0.114)),
    );
    histogram[luminance] = (histogram[luminance] ?? 0) + 1;
    samples += 1;
  }
  if (samples === 0) return 0;
  let entropy = 0;
  for (const count of histogram) {
    if (count === 0) continue;
    const probability = count / samples;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
};

export const preprocessVisionImage = async (
  bytes: Uint8Array,
  options: VisionPreprocessOptions,
): Promise<VisionPreprocessResult> => {
  if (!Number.isInteger(options.maximumDimension) || options.maximumDimension < 64) {
    throw new Error('Invalid maximum vision image dimension.');
  }
  const originalSha256 = sha256(bytes);
  const source = await loadImage(Buffer.from(bytes));
  const originalWidth = source.width;
  const originalHeight = source.height;
  if (
    originalWidth < (options.minimumDimension ?? 64) ||
    originalHeight < (options.minimumDimension ?? 64)
  ) {
    return {
      disposition: 'skipped',
      originalSha256,
      width: originalWidth,
      height: originalHeight,
      entropy: 0,
      reason: 'too-small',
    };
  }
  const aspectRatio =
    Math.max(originalWidth, originalHeight) / Math.min(originalWidth, originalHeight);
  if (aspectRatio > (options.maximumAspectRatio ?? 20)) {
    return {
      disposition: 'skipped',
      originalSha256,
      width: originalWidth,
      height: originalHeight,
      entropy: 0,
      reason: 'extreme-aspect-ratio',
    };
  }
  const scale = Math.min(1, options.maximumDimension / Math.max(originalWidth, originalHeight));
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  const entropy = imageEntropy(context.getImageData(0, 0, width, height).data);
  if (entropy < (options.minimumEntropy ?? 0.12)) {
    return {
      disposition: 'skipped',
      originalSha256,
      width,
      height,
      entropy,
      reason: 'low-entropy',
    };
  }
  const encoded = canvas.toBuffer('image/png');
  return {
    disposition: 'ready',
    bytes: encoded,
    mediaType: 'image/png',
    originalSha256,
    preprocessedSha256: sha256(encoded),
    width,
    height,
    originalWidth,
    originalHeight,
    entropy,
  };
};
