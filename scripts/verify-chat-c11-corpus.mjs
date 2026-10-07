import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const corpusPath = resolve(root, 'fixtures/chat/c11-conversation-evaluation.v1.json');
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));

const fail = (code) => {
  throw new Error(`chat-c11-corpus-invalid:${code}`);
};

if (corpus.contract !== 'noderag-chat-evaluation-corpus.v1') fail('contract');
if (
  corpus.providerBoundary?.ollamaMeaning !== 'ollama_cloud' ||
  corpus.providerBoundary?.ollamaServiceRoot !== 'https://ollama.com' ||
  corpus.providerBoundary?.internetProvider !== 'ollama_cloud' ||
  corpus.providerBoundary?.localOllamaAccepted !== false ||
  corpus.providerBoundary?.customOllamaEndpointAccepted !== false
)
  fail('cloud-boundary');

const requiredCategories = new Set([
  'research',
  'rag',
  'web',
  'citations',
  'artifacts',
  'compression',
  'refusal',
  'recovery',
]);
const ids = new Set();
let evidenceCount = 0;
for (const testCase of corpus.cases ?? []) {
  if (typeof testCase.id !== 'string' || ids.has(testCase.id)) fail('case-id');
  ids.add(testCase.id);
  requiredCategories.delete(testCase.category);
  if (typeof testCase.prompt !== 'string' || testCase.prompt.length < 20) fail('prompt');
  const policy = testCase.policy ?? {};
  if (![policy.research, policy.rag, policy.internet].every((value) => typeof value === 'boolean'))
    fail('policy');
  if (testCase.category === 'web' && policy.internet !== true) fail('web-opt-in');
  if (testCase.category !== 'web' && testCase.expected?.requiredTools?.includes('web.search.v1'))
    fail('unexpected-web-tool');
  if (!Array.isArray(testCase.evidence) || testCase.evidence.length === 0) fail('evidence');
  for (const evidence of testCase.evidence) {
    if (
      typeof evidence.file !== 'string' ||
      !evidence.file.startsWith('packages/') ||
      typeof evidence.test !== 'string' ||
      evidence.test.length === 0
    )
      fail('evidence-reference');
    const source = await readFile(resolve(root, evidence.file), 'utf8');
    if (!source.includes(evidence.test)) fail(`missing-test:${testCase.id}`);
    evidenceCount += 1;
  }
}
if (requiredCategories.size > 0) fail(`missing-categories:${[...requiredCategories].join(',')}`);

process.stdout.write(
  `${JSON.stringify({
    contract: corpus.contract,
    result: 'passed',
    cases: ids.size,
    evidenceReferences: evidenceCount,
    internetProvider: corpus.providerBoundary.internetProvider,
    localOllamaAccepted: false,
  })}\n`,
);
