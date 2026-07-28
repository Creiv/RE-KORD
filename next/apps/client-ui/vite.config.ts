import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 7422,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 7422 } : undefined,
    proxy: {
      "/api": "http://127.0.0.1:7420",
      "/media": "http://127.0.0.1:7420",
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
  },
});
