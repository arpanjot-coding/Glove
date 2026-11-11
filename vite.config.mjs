// SPDX-License-Identifier: MIT
import { defineConfig } from 'vite';
export default defineConfig({
  root: 'src/ui', base: './',
  build: {
    outDir: '../../dist', emptyOutDir: true,
    rolldownOptions: {
      onwarn(warning, warn) {
        // This is a client-only desktop renderer; React server directives do
        // not apply. Keep other dependency/build warnings visible.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client') && /@fluentui\/react-icons|@griffel\/react/.test(warning.message)) return;
        warn(warning);
      }
    }
  },
  server: { port: 5190, strictPort: true }
});
