import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

const certsDir = path.resolve(__dirname, '../certs')
const hasCerts = fs.existsSync(path.join(certsDir, 'cert.pem'))

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    ...(hasCerts && {
      https: {
        cert: fs.readFileSync(path.join(certsDir, 'cert.pem')),
        key: fs.readFileSync(path.join(certsDir, 'key.pem')),
      },
    }),
    proxy: {
      '/ws': {
        target: 'ws://localhost:9876',
        ws: true,
        secure: false,
        // Suppress noisy errors when sockets close during disconnect
        configure: (proxy) => {
          proxy.on('error', () => {});
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', () => {});
          });
          proxy.on('open', (proxySocket) => {
            proxySocket.on('error', () => {});
          });
        },
      },
      '/api': {
        target: 'http://localhost:9876',
        secure: false,
      },
    },
  },
})
