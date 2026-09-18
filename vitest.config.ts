import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	resolve: {
		alias: {
			// 与 vite.config 的 "@" alias 一致:beui registry 组件
			// (motion/button 等)经组件测试间接引入。
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
