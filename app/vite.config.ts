import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Clock-In Zeiterfassung",
        short_name: "Clock-In",
        description: "Zeiterfassung und Dienstplan für die Studios",
        lang: "de",
        display: "standalone",
        background_color: "#0f1513",
        theme_color: "#0f1513",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // App vorab cachen → startet schnell, auch bei schwachem Netz
        globPatterns: ["**/*.{js,css,html,svg,png}"],
      },
    }),
  ],
});
