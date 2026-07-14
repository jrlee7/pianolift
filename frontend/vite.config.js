import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
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
