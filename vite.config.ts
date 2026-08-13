import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    // @streamdown/code statically imports shiki's FULL language bundle
    // (~9.6MB / 1.7MB gzip). Acceptable for a local desktop app — assets load
    // from disk, not the network — so silence the chunk-size warning instead
    // of hacking around the plugin's imports.
    chunkSizeWarningLimit: 12000,
    rollupOptions: {
      output: {
        // Split the (large) streamdown/shiki tree out of the main bundle:
        // better caching and no >500kB single-chunk warnings. React stays in
        // the vendor chunk — splitting it out created a vendor → react →
        // vendor import cycle (harmless but noisy).
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("shiki") ||
            id.includes("streamdown") ||
            id.includes("@streamdown") ||
            id.includes("rehype") ||
            id.includes("remark") ||
            id.includes("unist") ||
            id.includes("hast") ||
            id.includes("mdast") ||
            id.includes("micromark") ||
            id.includes("vfile") ||
            id.includes("unified")
          ) {
            return "markdown";
          }
          return "vendor";
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
