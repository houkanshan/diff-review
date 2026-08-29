import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:47658',
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
})
