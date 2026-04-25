import { describe, expect, test } from "vitest";

import {
	extractElevatedTrackSegments,
	formatElevationRange,
	trackElevationRange,
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
