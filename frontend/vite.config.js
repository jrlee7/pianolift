import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// Baked in at build time so the running app can show which version it is
// (bottom-left badge). Read from package.json — the same version electron-
// builder ships and the auto-updater compares.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  // Relative asset paths so the packaged app can load them over file:// from
  // inside app.asar (default '/' breaks — absolute paths don't resolve → blank
  // white screen). Dev server is unaffected.
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // VITE_API_PORT lets a second dev instance pair with a backend on
        // a non-default port (parallel sessions); default stays 8000
        target: 'http://localhost:' + (process.env.VITE_API_PORT || '8000'),
        changeOrigin: true
      }
    }
  }
})
