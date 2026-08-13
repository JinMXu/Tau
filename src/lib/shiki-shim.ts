/**
 * Minimal `shiki` facade for @streamdown/code.
 *
 * The plugin imports the FULL `shiki` bundle (`bundle-full.mjs`), which
 * statically includes every language grammar (~9.6MB). Shiki's subpath
 * modules let us rebuild the same API with LAZY language/theme loading:
 * `shiki/langs` maps every language id to a dynamic `import()`, so only the
 * grammars actually highlighted by rendered code blocks get fetched.
 *
 * This module is wired in via `resolve.alias` in vite.config.ts.
 */
import { createBundledHighlighter } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import {
	bundledLanguages,
	bundledLanguagesInfo,
} from "shiki/langs";
import { bundledThemes } from "shiki/themes";

const createHighlighter = createBundledHighlighter({
	langs: bundledLanguages,
	themes: bundledThemes,
	engine: createJavaScriptRegexEngine,
});

export { createHighlighter, bundledLanguages, bundledLanguagesInfo };
