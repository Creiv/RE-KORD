import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 7421,
    proxy: {
      "/api": "http://127.0.0.1:7420",
      "/media": "http://127.0.0.1:7420",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
