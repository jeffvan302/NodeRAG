import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extractDocument } from '../packages/server/src/extract/index.js';
import {
  activateOllamaVision,
  OllamaVisionProvider,
} from '../packages/server/src/vision/ollama.js';
import { VisionProcessor } from '../packages/server/src/vision/service.js';

const baseUrl = process.env['NODERAG_M07_OLLAMA_URL'];
const model = process.env['NODERAG_M07_OLLAMA_MODEL'];
if (baseUrl === undefined || model === undefined) {
  throw new Error('NODERAG_M07_OLLAMA_URL and NODERAG_M07_OLLAMA_MODEL are required.');
}
const token = process.env['NODERAG_M07_OLLAMA_BEARER_TOKEN'];
const provider = new OllamaVisionProvider({
  baseUrl,
  model,
  ...(token === undefined ? {} : { bearerToken: token }),
});
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180_000);
try {
  const activation = await activateOllamaVision(
    provider,
    await readFile(resolve('fixtures/formats/images/table.png')),
    controller.signal,
  );
  const extracted = await extractDocument(
    await readFile(resolve('fixtures/formats/pdf/scanned.pdf')),
    'pdf',
    {},
    new VisionProcessor({ provider, timeoutMs: 180_000, maximumAttempts: 1 }),
  );
  if (!extracted.markdown.includes('noderag:vision') || extracted.markdown.length < 20) {
    throw new Error('The real provider did not produce searchable scanned-PDF Markdown.');
  }
  console.info(
    JSON.stringify({
      provider: provider.provider,
      model: activation.model.name,
      modelRevision: activation.model.digest,
      activationKind: activation.sample.kind,
      scannedPdfCharacters: extracted.markdown.length,
      securityWarning: provider.securityWarning(),
      status: 'passed',
    }),
  );
} finally {
  clearTimeout(timeout);
}
