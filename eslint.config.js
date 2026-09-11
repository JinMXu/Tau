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
);
