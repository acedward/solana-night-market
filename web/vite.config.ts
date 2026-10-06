import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The web app is a static site. It bundles the browser-safe Passport client from
// @nightmarket/core/passport and nothing that needs Node. The bundle holds ONE compact-runtime:
// 0.20.0, the compactc 0.35.0 account module's (through the `@midnight-ntwrk/compact-runtime-0.20`
// alias; the relay's SDK keeps 0.19.0, AA 00047 B1.5).
export default defineConfig({
  plugins: [react()],
  base: './',
  // AA 00060 P6.2: Bridge out's lazy chunk (midnight-js) reaches @subsquid/scale-codec, which calls
  // Node's `assert`: a small browser implementation instead of Vite's throwing stub.
  resolve: { alias: { assert: fileURLToPath(new URL('./src/shims/assert.ts', import.meta.url)) } },
  // Keep JSON as per-field exports (never one JSON.parse blob), so the bundle carries only the
  // fields of the vendored deployment records that the code actually imports.
  json: { namedExports: true, stringify: false },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
});
