import { describe, expect, test } from "vitest";

import { sortViewportObjectsByDistance } from "./viewport-objects";

describe("sortViewportObjectsByDistance", () => {
	test("orders places and tracks by distance from the viewport center", () => {
		const items = sortViewportObjectsByDistance(
			{
				latitude: 0,
				longitude: 0,
			},
			[
				{
					id: "track-far",
					title: "Far Track",
					min_lat: 2,
					min_lon: 2,
					max_lat: 4,
					max_lon: 4,
				},
				{
					id: "track-near",
					title: "Near Track",
					min_lat: -0.2,
					min_lon: -0.2,
					max_lat: 0.2,
					max_lon: 0.2,
				},
			],
			[
				{
					id: "place-mid",
					name: "Mid Place",
					latitude: 0.6,
					longitude: 0.6,
				},
				{
					id: "place-near",
					name: "Near Place",
					latitude: 0.05,
					longitude: 0.05,
				},
			],
		);

		expect(items.map((item) => item.id)).toEqual([
			"track-near",
			"place-near",
			"place-mid",
			"track-far",
		]);
		expect(items.map((item) => item.objectType)).toEqual([
			"track",
			"place",
			"place",
			"track",
		]);
	});
});
