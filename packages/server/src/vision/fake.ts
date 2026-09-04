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
    return {
      kind: request.sourceKind === 'worksheet-image' ? 'chart' : 'table',
      markdown: `| Vision fixture | Value |\n| --- | --- |\n| Image digest | ${marker} |`,
      alt: `Deterministic vision fixture ${marker}`,
      confidence: 0.99,
    };
  }
}
