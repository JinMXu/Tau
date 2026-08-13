import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		// Component-less pure helpers + settings/i18n logic; DOM-dependent
		// suites opt in per file via `// @vitest-environment happy-dom`.
	},
});
