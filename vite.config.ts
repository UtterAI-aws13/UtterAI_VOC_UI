import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/opensearch': {
        target: 'http://localhost:9200',
        rewrite: (path) => path.replace(/^\/opensearch/, ''),
        changeOrigin: true,
      },
    },
  },
})
