import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'session-migration-worker': resolve('src/main/services/session-migration-worker.ts'),
          'request-history-worker': resolve('src/main/services/request-history-worker.ts'),
          'quota-statistics-worker': resolve('src/main/services/quota-statistics-worker.ts')
        },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } } }
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react()]
  }
})
