import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
	{
		ignores: ["dist/**", "node_modules/**", "src-tauri/**"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.{ts,tsx}"],
		plugins: { "react-hooks": reactHooks },
		rules: {
			// Classic hooks rules only. The React Compiler era rules
			// ("purity", "set-state-in-effect", …) are intentionally not
			// enabled: they flag existing, intentional patterns throughout the
			// app (Date.now in render, setState in effects) that would need a
			// broader refactor to satisfy.
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "warn",
		},
	},
	{
		// shadcn/beUI registry-managed sources (installed via
		// `npx shadcn add @beui/…`). Kept byte-identical to the registry so
		// future `add` runs don't conflict; lint quirks (e.g. empty
		// `interface X extends Y {}` prop aliases) are silenced here instead
		// of edited in place.
		files: ["src/components/motion/**", "src/components/ui/**", "src/lib/ease.ts", "src/lib/utils.ts"],
		rules: {
			"@typescript-eslint/no-empty-object-type": "off",
		},
	},
	{
		// One-off Node scripts (runtime vendoring, spike smoke tests). They
		// run under plain node, so the browser-flavoured default globals
		// don't know process/console/fetch/timers; the spike scripts stay
		// unpolished on purpose, so the style rules that only fire there are
		// silenced rather than churning throwaway code.
		files: ["scripts/**/*.mjs"],
		languageOptions: {
			globals: {
				process: "readonly",
				console: "readonly",
				fetch: "readonly",
				URL: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/no-unused-expressions": "off",
			"no-empty": "off",
		},
	},
);
