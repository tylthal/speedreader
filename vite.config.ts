import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// basicSsl removed — Tailscale provides HTTPS for getUserMedia
import { VitePWA } from 'vite-plugin-pwa'
import { visualizer } from 'rollup-plugin-visualizer'
import { fileURLToPath, URL } from 'node:url'

// CAPACITOR=1 disables the PWA plugin so native (iOS/Android) builds skip
// the service worker, workbox runtime, and precache manifest. The native
// app unregisters any SW at startup (see src/main.tsx), so shipping these
// assets in the Capacitor bundle is wasted bytes.
const isCapacitorBuild = process.env.CAPACITOR === '1'

export default defineConfig({
  plugins: [
    react(),
    ...(isCapacitorBuild
      ? []
      : [VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Force new service worker to activate immediately
        skipWaiting: true,
        clientsClaim: true,
        // Precache all built assets. MediaPipe WASM + model are vendored under
        // public/mediapipe/ and served as same-origin static files, so no
        // runtime CDN caching rules are needed.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
      manifest: {
        name: 'SpeedReader',
        short_name: 'SpeedReader',
        description: 'A speed reading app with RSVP, eye-tracking pace control, and offline support.',
        theme_color: '#1C1C1E',
        background_color: '#1C1C1E',
        display: 'standalone',
        start_url: '/',
        categories: ['books', 'education', 'productivity'],
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
          },
          {
            src: '/pwa-maskable-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        screenshots: [
          {
            src: '/screenshots/desktop-wide.png',
            sizes: '1920x1080',
            type: 'image/png',
            form_factor: 'wide',
            label: 'SpeedReader library view',
          },
          {
            src: '/screenshots/mobile-narrow.png',
            sizes: '390x844',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'SpeedReader mobile library',
          },
        ],
      },
    })]),
  ],
  build: {
    rollupOptions: {
      plugins: [
        // Generates stats.html for bundle analysis (run: npx vite build && open stats.html)
        ...(process.env.ANALYZE
          ? [visualizer({ open: false, filename: 'stats.html', gzipSize: true })]
          : []),
      ],
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    allowedHosts: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
