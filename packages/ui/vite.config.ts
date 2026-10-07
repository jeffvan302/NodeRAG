import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // Keep emitted assets relative so the same build works at `/` in the
  // Docker testbed and below a Web Station alias such as `/noderag/`.
  base: './',
  plugins: [preact()],
  build: {
    manifest: true,
    sourcemap: false,
    target: 'es2022',
  },
});
