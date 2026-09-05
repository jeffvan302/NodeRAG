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
  external: ['onnxruntime-node', '@aws-sdk/client-s3', '@napi-rs/canvas'],
});

await cp(resolve(root, 'packages/ui/dist'), resolve(output, 'ui'), { recursive: true });
await cp(resolve(root, 'packages/server/migrations'), resolve(output, 'migrations'), {
  recursive: true,
});
await cp(
  resolve(root, 'platform/migration-checksums.v1.json'),
  resolve(output, 'migration-checksums.v1.json'),
);
await mkdir(resolve(output, 'vendor'), { recursive: true });
await cp(
  resolve(root, 'packages/server/node_modules/pdfjs-dist/legacy/build/pdf.mjs'),
  resolve(output, 'vendor/pdf.mjs'),
);
await cp(
  resolve(root, 'packages/server/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'),
  resolve(output, 'vendor/pdf.worker.mjs'),
);
await mkdir(resolve(output, 'node_modules/@napi-rs'), { recursive: true });
await cp(
  resolve(root, 'node_modules/.pnpm/@napi-rs+canvas@1.0.8/node_modules/@napi-rs/canvas'),
  resolve(output, 'node_modules/@napi-rs/canvas'),
  { recursive: true },
);
await mkdir(resolve(output, 'node_modules'), { recursive: true });
await cp(
  resolve(root, 'node_modules/.pnpm/onnxruntime-node@1.24.3/node_modules/onnxruntime-node'),
  resolve(output, 'node_modules/onnxruntime-node'),
  { recursive: true },
);
await cp(
  resolve(root, 'node_modules/.pnpm/onnxruntime-common@1.24.3/node_modules/onnxruntime-common'),
  resolve(output, 'node_modules/onnxruntime-common'),
  { recursive: true },
);
await Promise.all([
  rm(resolve(output, 'node_modules/onnxruntime-node/bin/napi-v6/darwin'), {
    recursive: true,
    force: true,
  }),
  rm(resolve(output, 'node_modules/onnxruntime-node/bin/napi-v6/linux/arm64'), {
    recursive: true,
    force: true,
  }),
  rm(resolve(output, 'node_modules/onnxruntime-node/bin/napi-v6/win32'), {
    recursive: true,
    force: true,
  }),
  rm(resolve(output, 'node_modules/onnxruntime-node/lib'), { recursive: true, force: true }),
  rm(resolve(output, 'node_modules/onnxruntime-node/script'), { recursive: true, force: true }),
]);
await cp(
  resolve(
    root,
    'node_modules/.pnpm/@napi-rs+canvas-linux-x64-gnu@1.0.8/node_modules/@napi-rs/canvas-linux-x64-gnu',
  ),
  resolve(output, 'node_modules/@napi-rs/canvas-linux-x64-gnu'),
  { recursive: true },
);
