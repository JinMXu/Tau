import { describe, expect, it } from "vitest";
import { createActivityTicker } from "../components/activity-ticker";

const slot = (id: string) => ({ id, kind: "tool" as const });

describe("createActivityTicker", () => {
	it("shows the first activity immediately and follows the newest after min dwell", () => {
		const ticker = createActivityTicker({ minDwellMs: 350 });
		let snap = ticker.ingest([slot("a")], 1000);
		expect(snap.currentId).toBe("a");
		expect(snap.switchAt).toBeNull();

		// burst within the dwell window: stays on a, schedules the switch
		snap = ticker.ingest([slot("a"), slot("b")], 1100);
		expect(snap.currentId).toBe("a");
		expect(snap.switchAt).toBe(1350);

		// more items arrive while waiting — latest-wins on tick
		snap = ticker.ingest([slot("a"), slot("b"), slot("c")], 1200);
		expect(snap.currentId).toBe("a");
		expect(snap.switchAt).toBe(1350);
		snap = ticker.tick(1350);
		expect(snap.currentId).toBe("c");

		// past the dwell window: switches immediately
		snap = ticker.ingest([slot("c"), slot("d")], 2000);
		expect(snap.currentId).toBe("d");
	});

	it("keeps the current activity when its own id is still the latest", () => {
		const ticker = createActivityTicker();
		ticker.ingest([slot("a")], 1000);
		const snap = ticker.ingest([slot("a")], 1100);
		expect(snap.currentId).toBe("a");
		expect(snap.switchAt).toBeNull();
	});

	it("clears to null when the activity list empties", () => {
		const ticker = createActivityTicker();
		ticker.ingest([slot("a")], 1000);
		const snap = ticker.ingest([], 1100);
		expect(snap.currentId).toBeNull();
		expect(snap.switchAt).toBeNull();
	});
});
