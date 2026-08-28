import { describe, expect, test } from "vitest";

import {
	buildTrackHeatmapFeatureCollection,
	metersToPixels,
	sampleLineByDistance,
} from "./track-heatmap";

const roughlyOneKilometre: GeoJSON.LineString = {
	type: "LineString",
	coordinates: [
		[153, -27],
		[153.010_08, -27],
	],
};

describe("sampleLineByDistance", () => {
	test("samples a line at no more than roughly 100 metre intervals", () => {
		const samples = sampleLineByDistance(roughlyOneKilometre.coordinates);
		expect(samples).toHaveLength(11);
		expect(samples[0]).toEqual(roughlyOneKilometre.coordinates[0]);
		expect(samples.at(-1)).toEqual(roughlyOneKilometre.coordinates.at(-1));
	});

	test("handles empty and very short lines", () => {
		expect(sampleLineByDistance([])).toEqual([]);
		expect(sampleLineByDistance([[153, -27]])).toEqual([[153, -27]]);
		expect(
			sampleLineByDistance([
				[153, -27],
				[153.000_01, -27],
			]),
		).toHaveLength(2);
	});
});

describe("buildTrackHeatmapFeatureCollection", () => {
	test("gives overlapping identical routes greater weight", () => {
		const single = buildTrackHeatmapFeatureCollection([
			{ id: "one", geometry: roughlyOneKilometre },
		]);
		const overlapping = buildTrackHeatmapFeatureCollection([
			{ id: "one", geometry: roughlyOneKilometre },
			{ id: "two", geometry: roughlyOneKilometre },
		]);
		expect(Math.max(...single.features.map((feature) => feature.properties.weight))).toBe(1);
		expect(
			Math.max(...overlapping.features.map((feature) => feature.properties.weight)),
		).toBe(2);
	});

	test("produces equivalent cells for sparse and dense versions of a route", () => {
		const dense: GeoJSON.LineString = {
			type: "LineString",
			coordinates: Array.from({ length: 101 }, (_, index) => [
				153 + (0.010_08 * index) / 100,
				-27,
			]),
		};
		const sparseCells = buildTrackHeatmapFeatureCollection([
			{ id: "sparse", geometry: roughlyOneKilometre },
		]);
		const denseCells = buildTrackHeatmapFeatureCollection([
			{ id: "dense", geometry: dense },
		]);
		expect(denseCells).toEqual(sparseCells);
	});

	test("supports multi-line geometry and excludes hidden tracks", () => {
		const heatmap = buildTrackHeatmapFeatureCollection(
			[
				{
					id: "visible",
					geometry: {
						type: "MultiLineString",
						coordinates: [
							[],
							[[153, -27]],
							[
								[153.01, -27],
								[153.011, -27],
							],
						],
					},
				},
				{ id: "hidden", geometry: roughlyOneKilometre },
			],
			new Set(["hidden"]),
		);
		expect(heatmap.features.length).toBeGreaterThan(0);
		expect(heatmap.features.every((feature) => feature.properties.weight === 1)).toBe(true);
	});

	test("uses the selected radius as the geographic sampling and cell scale", () => {
		const narrow = buildTrackHeatmapFeatureCollection(
			[{ id: "track", geometry: roughlyOneKilometre }],
			new Set(),
			25,
		);
		const wide = buildTrackHeatmapFeatureCollection(
			[{ id: "track", geometry: roughlyOneKilometre }],
			new Set(),
			250,
		);
		expect(narrow.features.length).toBeGreaterThan(wide.features.length);
	});
});

describe("metersToPixels", () => {
	test("increases with zoom and with latitude", () => {
		const equatorAtZoom10 = metersToPixels(100, 10, 0);
		expect(metersToPixels(100, 11, 0)).toBeCloseTo(equatorAtZoom10 * 2);
		expect(metersToPixels(100, 10, 60)).toBeCloseTo(equatorAtZoom10 * 2);
	});
});
