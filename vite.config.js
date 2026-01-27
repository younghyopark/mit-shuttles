import { defineConfig } from 'vite';

export default defineConfig({
  // Base path for GitHub Pages (repo name)
  base: '/mit-shuttles/',
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
});
