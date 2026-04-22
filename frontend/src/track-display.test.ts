import { describe, expect, test } from "vitest";

import { displayTrackColor, displayTrackHue } from "./track-display";

describe("displayTrackColor", () => {
	test("gives stable but distinct colors for different track ids", () => {
		expect(displayTrackColor("track-a")).not.toEqual(displayTrackColor("track-b"));
		expect(displayTrackColor("track-a")).toEqual(displayTrackColor("track-a"));
	});

	test("avoids green and blue hue bands used by the map", () => {
		for (const trackId of ["track-a", "track-b", "track-c", "track-d", "track-e"]) {
			const hue = displayTrackHue(trackId);
			expect(hue).toBeGreaterThanOrEqual(0);
			expect(hue).toBeLessThan(360);
			expect(
				(hue >= 8 && hue <= 58) ||
					(hue >= 275 && hue <= 305) ||
					(hue >= 322 && hue <= 348),
			).toBe(true);
		}
	});
});
