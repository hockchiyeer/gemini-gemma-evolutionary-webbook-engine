import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {googleSearchFallbackPlugin} from './server/googleSearchFallback.ts';
import {geminiPlugin} from './server/geminiService.ts';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), geminiPlugin(), googleSearchFallbackPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
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
