import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

// The device-link protocol is SHARED with the desktop: imported straight from the desktop
// source so both sides always speak exactly the same protocol.
const link = fileURLToPath(new URL('../src/main/devices/link.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@link': link } },
  server: { fs: { allow: ['..'] } },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
});
