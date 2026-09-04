import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'packages/server/dist');
await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });

await build({
  entryPoints: {
    embedder: resolve(root, 'packages/embedder/src/main.ts'),
    server: resolve(root, 'packages/server/src/main.ts'),
    worker: resolve(root, 'packages/server/src/worker.ts'),
  },
  bundle: true,
  format: 'cjs',
  logLevel: 'info',
  minify: false,
  outdir: output,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  sourcemap: false,
  target: 'node22',
  external: ['onnxruntime-node'],
});

await cp(resolve(root, 'packages/ui/dist'), resolve(output, 'ui'), { recursive: true });
await cp(resolve(root, 'packages/server/migrations'), resolve(output, 'migrations'), {
  recursive: true,
});
await cp(
  resolve(root, 'platform/migration-checksums.v1.json'),
  resolve(output, 'migration-checksums.v1.json'),
);
