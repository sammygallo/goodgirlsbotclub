import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vite dev proxies everything that isn't a static asset to ggbc-backend,
// which serves /auth/* /sync/* /invitations/* /health itself and forwards
// /api/* /thumbnail /characters /scripts /csrf-token to SillyTavern with
// the per-user ST session it manages. Override the target via the
// GGBC_BACKEND env var if you're running two worktrees in parallel.
//
// Use 127.0.0.1 (not localhost) — node 18+ resolves localhost to IPv6 ::1
// first, and Docker publishes 127.0.0.1:8001 IPv4-only, so the localhost
// form silently fails before the proxy gets a chance to send anything.
const BACKEND = process.env.GGBC_BACKEND || 'http://127.0.0.1:8001'

const proxyTarget = {
  target: BACKEND,
  changeOrigin: true,
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    proxy: {
      '/auth': proxyTarget,
      '/sync': proxyTarget,
      '/blobs': proxyTarget,
      '/invitations': proxyTarget,
      '/health': proxyTarget,
      '/api': proxyTarget,
      '/csrf-token': proxyTarget,
      '/thumbnail': proxyTarget,
      '/characters': proxyTarget,
      '/chats': proxyTarget,
      '/scripts': {
        ...proxyTarget,
        // Specific upstream-compat shim modules served from public/ must NOT
        // be proxied — they shadow upstream files of the same name so
        // ES-module-based extensions can `import { ... } from '../../../...'`
        // without dragging in the upstream monolith. Returning the request
        // URL bypasses the proxy and lets Vite's static middleware serve the
        // public/ copy.
        bypass(req) {
          const url = req.url || ''
          const path = url.split('?')[0]
          if (
            path === '/scripts/extensions.js' ||
            path === '/scripts/slash-commands.js' ||
            path === '/scripts/utils.js'
          ) {
            return url
          }
          return undefined
        },
      },
    },
  },
})
