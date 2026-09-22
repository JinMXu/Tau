import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			// shadcn/beUI registry sources import helpers via "@/lib/utils" etc.
			"@": path.resolve(__dirname, "./src"),
		},
	},

	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent Vite from obscuring rust errors
	clearScreen: false,
	build: {
		// No manualChunks: a react/non-react chunk split produces circular
		// chunk initialization (vendor's React namespace is still undefined
		// when the markdown chunk evaluates `createContext`), which white-
		// screens only production builds — dev serves unbundled ESM and
		// never sees it. A desktop app loads from local disk, so one larger
		// bundle costs nothing meaningful.
	},
	// 2. tauri expects a fixed port, fail if that port is not available.
	// 1422 rather than the default 1420: another Tauri project on this machine
	// (novel-ide) already develops on 1420, and strictPort would collide. Keep
	// in sync with build.devUrl in src-tauri/tauri.conf.json.
	server: {
		port: 1422,
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
