import { describe, expect, test } from "vitest";

import { estimateAreaExtractTiles } from "./area-estimate";

describe("estimateAreaExtractTiles", () => {
	test("counts one tile per zoom level for a bbox inside a single z2 tile", () => {
		expect(
			estimateAreaExtractTiles(
				{
					minLon: 9,
					minLat: 9,
					maxLon: 11,
					maxLat: 11,
				},
				2,
			),
		).toBe(3);
	});

	test("counts the world-to-6 pyramid for a global bbox", () => {
		expect(
			estimateAreaExtractTiles(
				{
					minLon: -180,
					minLat: -85.051129,
					maxLon: 180,
					maxLat: 85.051129,
				},
				6,
			),
		).toBe(5461);
	});
});
