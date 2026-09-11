import { describe, expect, it } from "vitest";
import { formatBytes, formatClockDuration, formatDuration, projectNameFromPath } from "../format";

describe("projectNameFromPath", () => {
	it("extracts the last path segment", () => {
		expect(projectNameFromPath("D:\\projects\\demo")).toBe("demo");
		expect(projectNameFromPath("/home/u/work")).toBe("work");
		expect(projectNameFromPath("C:\\")).toBe("C:");
	});

	it("handles empty values", () => {
		expect(projectNameFromPath(null)).toBe("");
		expect(projectNameFromPath(undefined)).toBe("");
		expect(projectNameFromPath("")).toBe("");
	});
});

describe("formatDuration", () => {
	it("uses seconds, minutes and hours at the right thresholds", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(185_000)).toBe("3m 05s");
		expect(formatDuration(3_720_000)).toBe("1h 02m");
	});

	it("clamps negative input", () => {
		expect(formatDuration(-5)).toBe("0s");
	});
});

describe("formatClockDuration", () => {
	it("switches to m:ss past a minute", () => {
		expect(formatClockDuration(42_000)).toBe("42s");
		expect(formatClockDuration(65_000)).toBe("1:05");
	});
});

describe("formatBytes", () => {
	it("scales through B / KB / MB", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
	});
});
