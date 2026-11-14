import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Three bundles, loaded by Chrome straight from dist/ (public/manifest.json is copied as is):
// the side panel page, the background service worker and the Gmail content script. The worker and
// the content script import nothing at runtime, so each builds to one self-contained file.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1000, // loaded from disk, not the network
    rollupOptions: {
      input: {
        sidepanel: 'sidepanel.html',
        background: 'src/background.ts',
        gmail: 'src/gmail/content.ts',
      },
      output: { entryFileNames: '[name].js' },
    },
  },
});
