import type { ServerResponse } from "node:http";
import { defineConfig, type ProxyOptions } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;

/** When the hub is down, default http-proxy sends 500 with an empty body → client `.json()` throws. */
function hubProxy(target: string): ProxyOptions {
  return {
    target,
    configure(proxy) {
      proxy.on("error", (_err, _req, res) => {
        const r = res as ServerResponse | undefined;
        if (!r || r.headersSent || typeof r.writeHead !== "function") return;
        r.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        r.end(JSON.stringify({ ok: false, error: "Hub non raggiungibile" }));
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 7422,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 7422 } : undefined,
    proxy: {
      "/api": hubProxy("http://127.0.0.1:7420"),
      "/media": hubProxy("http://127.0.0.1:7420"),
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
  },
});
