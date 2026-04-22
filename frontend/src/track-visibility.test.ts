import { describe, expect, test } from "vitest";

import { filterVisibleTracks } from "./track-visibility";

describe("filterVisibleTracks", () => {
	test("removes hidden tracks from the map layer set but keeps other tracks", () => {
		expect(
			filterVisibleTracks(
				[
					{ id: "track-a", title: "A" },
					{ id: "track-b", title: "B" },
				],
				new Set(["track-b"]),
			).map((track) => track.id),
		).toEqual(["track-a"]);
	});
});
