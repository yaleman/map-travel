import { describe, expect, test } from "vitest";

import { googleMapsViewportUrl } from "./google-maps-link";

describe("googleMapsViewportUrl", () => {
	test("formats the current viewport into a Google Maps URL", () => {
		expect(
			googleMapsViewportUrl({
				latitude: -27.4698,
				longitude: 153.0251,
				zoom: 12.3456,
			}),
		).toBe("https://www.google.com/maps/@-27.46980,153.02510,12.35z");
	});
});
