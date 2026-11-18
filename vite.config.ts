import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    sourcemap: process.env.JINI_SOURCEMAPS === '1',
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  plugins: [react()],
});
