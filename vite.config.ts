import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Build straight into the API server's folder so one process serves everything
    outDir: 'server/dist',
    emptyOutDir: true,
  },
  server: {
    // Dedicated dev port for THIS copy (original uses 5173).
    port: 6173,
    strictPort: true,
    // Proxy API calls to this copy's server (server/, port 9787).
    proxy: {
      '/api': 'http://localhost:9787',
    },
  },
})
