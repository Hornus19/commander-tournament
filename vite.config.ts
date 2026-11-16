import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'Commander Tournament',
        short_name: 'Commander Tournament',
        description: 'Aplicación para torneos de Commander.',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        theme_color: '#863bff',
        background_color: '#ffffff',
        icons: [
          {
            src: '/icons/commander-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
          },
          {
            src: '/icons/commander-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{css,html,ico,js,png,svg,woff,woff2}'],
      },
    }),
  ],
})
