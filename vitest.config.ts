import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	resolve: {
		alias: {
			// The vendored beUI registry sources import helpers via "@/lib/..."
			// (same alias as vite.config.ts) — tests that render them need it.
			"@": path.resolve(__dirname, "./src"),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		// Component-less pure helpers + settings/i18n logic; DOM-dependent
		// suites opt in per file via `// @vitest-environment happy-dom`.
	},
});
