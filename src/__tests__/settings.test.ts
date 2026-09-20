// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	saveSettings,
	resolveTheme,
	type AppSettings,
} from "../settings";

const KEY = "pi-gui.settings.v5";

describe("settings persistence", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("returns defaults when nothing is stored", () => {
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
	});

	it("round-trips valid settings", () => {
		const custom: AppSettings = {
			...DEFAULT_SETTINGS,
			theme: "dark",
			fontSize: 16,
			language: "en",
			customTools: ["read", "bash"],
			systemPrompt: "be concise",
		};
		saveSettings(custom);
		expect(loadSettings()).toEqual(custom);
	});

	it("sanitizes invalid enum values", () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({
				theme: "neon",
				language: "fr",
				fontSize: "big",
				customTools: ["bash", "rm", 42],
				chatFontFamily: "comic-sans",
				chatContentWidth: "huge",
				chatLineSpacing: "wild",
				sendDuringRunMode: "yolo",
			}),
		);
		const s = loadSettings();
		expect(s.theme).toBe(DEFAULT_SETTINGS.theme); // enum: "neon" is rejected
		expect(s.language).toBe(DEFAULT_SETTINGS.language);
		expect(s.fontSize).toBe(DEFAULT_SETTINGS.fontSize); // non-number rejected
		expect(s.customTools).toEqual(["bash"]);
		expect(s.chatFontFamily).toBe(DEFAULT_SETTINGS.chatFontFamily);
		expect(s.chatContentWidth).toBe(DEFAULT_SETTINGS.chatContentWidth);
		expect(s.chatLineSpacing).toBe(DEFAULT_SETTINGS.chatLineSpacing);
		expect(s.sendDuringRunMode).toBe(DEFAULT_SETTINGS.sendDuringRunMode);
	});

	it("clamps fontSize to a sane range", () => {
		localStorage.setItem(KEY, JSON.stringify({ fontSize: 999 }));
		expect(loadSettings().fontSize).toBe(28);
		localStorage.setItem(KEY, JSON.stringify({ fontSize: -3 }));
		expect(loadSettings().fontSize).toBe(10);
		localStorage.setItem(KEY, JSON.stringify({ fontSize: 16.4 }));
		expect(loadSettings().fontSize).toBe(16);
	});

	it("falls back to defaults on corrupt JSON", () => {
		localStorage.setItem(KEY, "{not json");
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
	});
});

describe("resolveTheme", () => {
	it("follows explicit light/dark and system preference", () => {
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("system", false)).toBe("light");
	});
});
