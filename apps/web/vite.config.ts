import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = `http://127.0.0.1:${process.env.NOEMA_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // The API and its event streams live on the local server.
    proxy: { '/api': { target: server } },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
