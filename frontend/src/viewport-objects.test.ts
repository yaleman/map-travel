import { describe, expect, test } from "vitest";

import {
	filterViewportObjects,
	sortViewportObjectsByDistance,
} from "./viewport-objects";

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

describe("filterViewportObjects", () => {
	const tracks = [
		{
			id: "track-1",
			title: "Summit Walk",
			original_filename: "mueller-hut.gpx",
			notes: "Alpine day walk",
			min_lat: -1,
			min_lon: -1,
			max_lat: 1,
			max_lon: 1,
		},
		{
			id: "track-2",
			title: null,
			original_filename: "city-loop.gpx",
			notes: null,
			min_lat: -2,
			min_lon: -2,
			max_lat: 2,
			max_lon: 2,
		},
	];
	const places = [
		{
			id: "place-1",
			name: "Hooker Valley Trailhead",
			category: "trailhead",
			notes: "Start of the walk",
			latitude: 0,
			longitude: 0,
		},
		{
			id: "place-2",
			name: "City Cafe",
			category: null,
			notes: "Breakfast stop",
			latitude: 1,
			longitude: 1,
		},
	];

	test("returns all in-view objects for an empty query", () => {
		const result = filterViewportObjects("   ", tracks, places);

		expect(result.tracks.map((track) => track.id)).toEqual([
			"track-1",
			"track-2",
		]);
		expect(result.places.map((place) => place.id)).toEqual([
			"place-1",
			"place-2",
		]);
	});

	test("matches in-view place and track visible metadata", () => {
		expect(filterViewportObjects("trailhead", tracks, places).places).toEqual([
			places[0],
		]);
		expect(filterViewportObjects("MUELLER", tracks, places).tracks).toEqual([
			tracks[0],
		]);
		expect(filterViewportObjects("breakfast", tracks, places).places).toEqual([
			places[1],
		]);
	});
});
