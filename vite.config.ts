import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

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
		rollupOptions: {
			output: {
				// Split the (large) markstream/shiki/monaco tree out of the main bundle:
				// better caching and no >500kB single-chunk warnings.
				manualChunks(id) {
					if (!id.includes("node_modules")) return undefined;
					if (
						id.includes("markstream") ||
						id.includes("stream-markdown") ||
						id.includes("stream-monaco") ||
						id.includes("mermaid") ||
						id.includes("katex") ||
						id.includes("shiki") ||
						id.includes("d3-")
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
