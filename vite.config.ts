import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {googleSearchFallbackPlugin} from './server/googleSearchFallback.ts';
import {geminiPlugin} from './server/geminiService.ts';
import {webBookStorePlugin} from './server/webBookStore.ts';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), geminiPlugin(), googleSearchFallbackPlugin(), webBookStorePlugin()],
    // html2canvas and jspdf are only imported when an export button is clicked. In the Vite dev server (AI Studio) a late-discovered
    // dependency triggers a re-optimisation that invalidates the already-issued module URL ("Failed to fetch dynamically imported module").
    // jspdf loads canvg and dompurify (and fflate / fast-png) lazily; if they are only discovered at the first export click, Vite re-optimises
    // and the already-open page asks for the outdated /node_modules/.vite/deps/jspdf.js?v=<old hash>. Listing them here pre-bundles them at start.
    optimizeDeps: {
      include: ['html2canvas', 'jspdf', 'canvg', 'dompurify', 'fflate', 'fast-png'],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
      watch: {
        ignored: ['**/models/**', '**/dist/**', '**/public/fonts/**', '**/*.gguf', '**/saved_webbooks/**', '**/exports/**'],
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
  };
});
