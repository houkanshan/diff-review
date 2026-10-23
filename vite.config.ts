import { writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Build-time compression keeps CPU-heavy work out of HTTP requests. Public files
// are left untouched; only generated JS/CSS/HTML and related build assets qualify.
function precompressAssets(): Plugin {
  const brotli = promisify(brotliCompress)
  const gz = promisify(gzip)
  return {
    name: 'precompress-assets',
    apply: 'build',
    async writeBundle(options, bundle) {
      await Promise.all(Object.values(bundle).map(async (entry) => {
        if (!/\.(?:js|css|html|svg|json|wasm)$/.test(entry.fileName)) return
        const body = Buffer.from(entry.type === 'chunk' ? entry.code : entry.source)
        if (body.length < 1024) return
        const variants = await Promise.all([
          brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
          gz(body, { level: 9 }),
        ])
        await Promise.all(variants.map(async (compressed, index) => {
          if (compressed.length >= body.length * 0.9) return
          const file = path.join(options.dir!, entry.fileName) + (index === 0 ? '.br' : '.gz')
          await writeFile(file + '.tmp', compressed)
          await rename(file + '.tmp', file)
        }))
      }))
    },
  }
}

export default defineConfig({
  plugins: [react(), precompressAssets()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:47658',
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
})
