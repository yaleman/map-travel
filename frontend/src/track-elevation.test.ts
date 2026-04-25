import { describe, expect, test } from "vitest";

import {
	buildElevatedTrackExtrusionFeatureCollection,
	elevatedTrackExtrusionStats,
	extractElevatedTrackSegments,
	formatElevationRange,
	trackElevationRange,
	trackElevationProfile,
} from "./track-elevation";

describe("extractElevatedTrackSegments", () => {
	test("extracts consecutive elevated line positions", () => {
		expect(
			extractElevatedTrackSegments({
				type: "LineString",
				coordinates: [
					[153.0, -27.0, 10],
					[153.1, -27.1, 25],
					[153.2, -27.2],
					[153.3, -27.3, 40],
					[153.4, -27.4, 50],
				],
			}),
		).toEqual([
			[
				{ longitude: 153.0, latitude: -27.0, elevationMeters: 10 },
				{ longitude: 153.1, latitude: -27.1, elevationMeters: 25 },
			],
			[
				{ longitude: 153.3, latitude: -27.3, elevationMeters: 40 },
				{ longitude: 153.4, latitude: -27.4, elevationMeters: 50 },
			],
		]);
	});

	test("extracts elevated segments from multi line strings", () => {
		expect(
			extractElevatedTrackSegments({
				type: "MultiLineString",
				coordinates: [
					[
						[153.0, -27.0, 10],
						[153.1, -27.1, 20],
					],
					[
						[153.2, -27.2],
						[153.3, -27.3, 30],
					],
				],
			}),
		).toEqual([
			[
				{ longitude: 153.0, latitude: -27.0, elevationMeters: 10 },
				{ longitude: 153.1, latitude: -27.1, elevationMeters: 20 },
			],
		]);
	});
});

describe("trackElevationRange", () => {
	test("returns min and max from mixed 2d and 3d coordinates", () => {
		expect(
			trackElevationRange({
				type: "LineString",
				coordinates: [
					[153.0, -27.0],
					[153.1, -27.1, 80],
					[153.2, -27.2, 120],
				],
			}),
		).toEqual({ min: 80, max: 120 });
	});

	test("returns null when no elevation data is available", () => {
		expect(
			trackElevationRange({
				type: "LineString",
				coordinates: [
					[153.0, -27.0],
					[153.1, -27.1],
				],
			}),
		).toBeNull();
	});
});

describe("formatElevationRange", () => {
	test("formats rounded metres without repeating the field label", () => {
		expect(formatElevationRange({ min: 149.2, max: 800.8 })).toBe("149-801 m");
	});
});

describe("trackElevationProfile", () => {
	test("returns ordered profile points with normalized progress", () => {
		expect(
			trackElevationProfile({
				type: "LineString",
				coordinates: [
					[153.0, -27.0, 10],
					[153.1, -27.1, 20],
					[153.2, -27.2, 50],
				],
			}),
		).toEqual({
			segments: [
				{
					points: [
						{
							longitude: 153.0,
							latitude: -27.0,
							elevationMeters: 10,
							progress: 0,
						},
						{
							longitude: 153.1,
							latitude: -27.1,
							elevationMeters: 20,
							progress: 0.5,
						},
						{
							longitude: 153.2,
							latitude: -27.2,
							elevationMeters: 50,
							progress: 1,
						},
					],
				},
			],
			range: { min: 10, max: 50 },
			sampleCount: 3,
		});
	});

	test("keeps gaps between elevated coordinate runs", () => {
		expect(
			trackElevationProfile({
				type: "LineString",
				coordinates: [
					[153.0, -27.0, 10],
					[153.1, -27.1, 20],
					[153.2, -27.2],
					[153.3, -27.3, 50],
					[153.4, -27.4, 80],
				],
			})?.segments.map((segment) =>
				segment.points.map((point) => point.elevationMeters),
			),
		).toEqual([
			[10, 20],
			[50, 80],
		]);
	});

	test("returns null when there are not enough elevated samples", () => {
		expect(
			trackElevationProfile({
				type: "LineString",
				coordinates: [[153.0, -27.0, 10]],
			}),
		).toBeNull();
	});
});

describe("buildElevatedTrackExtrusionFeatureCollection", () => {
	test("turns an elevated line segment into an oriented ribbon polygon", () => {
		const collection = buildElevatedTrackExtrusionFeatureCollection([
			{
				id: "track-a",
				selected: true,
				geometry: {
					type: "LineString",
					coordinates: [
						[153.0, -27.0, 100],
						[153.001, -27.0, 140],
					],
				},
			},
		]);

		expect(collection.features).toHaveLength(1);
		expect(collection.features[0].properties).toEqual({
			track_id: "track-a",
			selected: true,
			height_m: 120,
		});
		const ring = collection.features[0].geometry.coordinates[0];
		expect(ring).toHaveLength(5);
		expect(ring[0]).toEqual(ring[4]);
		expect(ring[0][0]).toBeCloseTo(153.0, 6);
		expect(ring[0][1]).toBeGreaterThan(-27.0);
		expect(ring[3][1]).toBeLessThan(-27.0);
	});

	test("splits mixed 2d and 3d coordinate runs into usable extrusion segments", () => {
		const collection = buildElevatedTrackExtrusionFeatureCollection([
			{
				id: "track-a",
				selected: false,
				geometry: {
					type: "LineString",
					coordinates: [
						[153.0, -27.0, 10],
						[153.001, -27.0, 20],
						[153.002, -27.0],
						[153.003, -27.0, 50],
						[153.004, -27.0, 80],
					],
				},
			},
		]);

		expect(collection.features.map((feature) => feature.properties.height_m)).toEqual([
			15, 65,
		]);
	});

	test("builds features across multiline elevated segments", () => {
		const collection = buildElevatedTrackExtrusionFeatureCollection([
			{
				id: "track-a",
				selected: false,
				geometry: {
					type: "MultiLineString",
					coordinates: [
						[
							[153.0, -27.0, 10],
							[153.001, -27.0, 20],
						],
						[
							[153.002, -27.0, 30],
							[153.003, -27.0, 40],
							[153.004, -27.0, 50],
						],
					],
				},
			},
		]);

		expect(collection.features.map((feature) => feature.properties.height_m)).toEqual([
			15, 35, 45,
		]);
	});

	test("skips duplicate zero-length coordinate pairs", () => {
		const collection = buildElevatedTrackExtrusionFeatureCollection([
			{
				id: "track-a",
				selected: false,
				geometry: {
					type: "LineString",
					coordinates: [
						[153.0, -27.0, 10],
						[153.0, -27.0, 20],
						[153.001, -27.0, 40],
					],
				},
			},
		]);

		expect(collection.features).toHaveLength(1);
		expect(collection.features[0].properties.height_m).toBe(30);
	});

	test("summarizes extrusion feature counts and selected height", () => {
		const collection = buildElevatedTrackExtrusionFeatureCollection([
			{
				id: "track-a",
				selected: false,
				geometry: {
					type: "LineString",
					coordinates: [
						[153.0, -27.0, 10],
						[153.001, -27.0, 20],
					],
				},
			},
			{
				id: "track-b",
				selected: true,
				geometry: {
					type: "LineString",
					coordinates: [
						[153.0, -27.0, 100],
						[153.001, -27.0, 140],
					],
				},
			},
		]);

		expect(elevatedTrackExtrusionStats(collection)).toEqual({
			featureCount: 2,
			selectedFeatureCount: 1,
			maxHeightM: 120,
		});
	});
});
