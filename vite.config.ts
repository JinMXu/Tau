import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: [
      // @streamdown/code imports the FULL shiki bundle (all grammars inlined,
      // ~9.6MB). Swap it for a facade with lazy per-language loading — only
      // grammars that actually appear in code blocks are fetched.
      // (Exact match so subpath imports like shiki/core stay untouched.)
      { find: /^shiki$/, replacement: path.resolve(__dirname, "src/lib/shiki-shim.ts") },
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    // With the lazy shiki facade the markdown chunk is small; keep the
    // default warning threshold.
    rollupOptions: {
      output: {
        // Split the (large) streamdown/shiki tree out of the main bundle:
        // better caching and no >500kB single-chunk warnings. React stays in
        // the vendor chunk — splitting it out created a vendor → react →
        // vendor import cycle (harmless but noisy).
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
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
            // NOTE: shiki modules are deliberately NOT forced into this
            // chunk — @shikijs/langs/* are dynamically imported per language,
            // and a manualChunks match would inline all ~280 grammars back
            // into one giant chunk.
            return "markdown";
          }
          // Let shiki's per-language dynamic imports (@shikijs/langs/*) stay
          // auto-split into on-demand chunks.
          if (id.includes("shiki")) return undefined;
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
