import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin API in development; the server keeps checking Host/Origin.
    proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: false } },
  },
});
