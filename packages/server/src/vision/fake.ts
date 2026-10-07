import { createHash } from 'node:crypto';
import {
  VISION_PROVIDER_CONTRACT_VERSION,
  type ValidatedVisionResponse,
  type VisionProvider,
  type VisionProviderRequest,
} from './contract.js';

export class DeterministicFakeVisionProvider implements VisionProvider {
  readonly provider: string = 'deterministic-fake';
  readonly model: string = 'fake-vision-v1';
  readonly modelRevision: string = 'fake-vision-v1';
  readonly contractVersion = VISION_PROVIDER_CONTRACT_VERSION;

  async analyse(request: VisionProviderRequest): Promise<ValidatedVisionResponse> {
    if (request.signal.aborted) throw request.signal.reason;
    const digest = createHash('sha256').update(request.bytes).digest('hex');
    const marker = digest.slice(0, 12);
    const markdown = `| Vision fixture | Value |\n| --- | --- |\n| Image digest | ${marker} |`;
    return {
      kind: request.sourceKind === 'worksheet-image' ? 'chart' : 'table',
      markdown,
      alt: `Deterministic vision fixture ${marker}`,
      confidence: 0.99,
      ...(request.sourceKind === 'pdf-page' || request.sourceKind === 'pdf-region'
        ? {
            layoutBlocks: [
              {
                kind: 'table' as const,
                markdown,
                text: `Vision fixture Value Image digest ${marker}`,
                confidence: 0.99,
                sourceImageIndex: 1,
                bounds: { x: 0, y: 0, width: 1, height: 1 },
              },
            ],
          }
        : {}),
    };
  }

  async analyseMany(
    requests: readonly VisionProviderRequest[],
  ): Promise<readonly ValidatedVisionResponse[]> {
    const results = await Promise.all(requests.map((request) => this.analyse(request)));
    return results.map((result, index) => ({
      ...result,
      ...(result.layoutBlocks === undefined
        ? {}
        : {
            layoutBlocks: result.layoutBlocks.map((block) => ({
              ...block,
              sourceImageIndex: index + 1,
            })),
          }),
    }));
  }
}
