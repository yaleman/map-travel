import { describe, expect, test } from "vitest";

import {
	clampMissingTileZoom,
	missingTilesQueryString,
	missingTilesSettingsUrl,
	parseSettingsAreaPrefill,
} from "./missing-tiles";

describe("clampMissingTileZoom", () => {
	test("floors and clamps zoom for area extracts", () => {
		expect(clampMissingTileZoom(12.8)).toBe(12);
		expect(clampMissingTileZoom(7.9)).toBe(7);
		expect(clampMissingTileZoom(-1)).toBe(0);
	});
});

describe("missingTilesQueryString", () => {
	test("formats viewport bounds and tile zoom for the backend", () => {
		expect(
			missingTilesQueryString(
				{
					minLon: 135.8789064,
					minLat: 34.0162422,
					maxLon: 136.2304689,
					maxLat: 34.3071439,
				},
				12.7,
			),
		).toBe(
			"min_lon=135.878906&min_lat=34.016242&max_lon=136.230469&max_lat=34.307144&tile_zoom=12",
		);
	});
});

describe("missingTilesSettingsUrl", () => {
	test("builds a settings URL with the missing tile area and max zoom", () => {
		expect(
			missingTilesSettingsUrl({
				missing: true,
				tile_zoom: 12,
				missing_tile_count: 5,
				bounds: [135.878906, 34.016242, 136.230469, 34.307144],
				max_zoom: 12,
			}),
		).toBe(
			"/settings?area=135.878906%2C34.016242%2C136.230469%2C34.307144&max_zoom=12&label=Missing+map+detail",
		);
	});

	test("falls back to the settings screen when no missing bounds are available", () => {
		expect(
			missingTilesSettingsUrl({
				missing: false,
				tile_zoom: 8,
				missing_tile_count: 0,
				bounds: null,
				max_zoom: null,
			}),
		).toBe("/settings");
	});
});

describe("parseSettingsAreaPrefill", () => {
	test("parses area, zoom, and label from settings query params", () => {
		expect(
			parseSettingsAreaPrefill(
				"?area=135.878906,34.016242,136.230469,34.307144&max_zoom=12&label=Missing%20map%20detail",
			),
		).toEqual({
			bounds: {
				minLon: 135.878906,
				minLat: 34.016242,
				maxLon: 136.230469,
				maxLat: 34.307144,
			},
			label: "Missing map detail",
			maxZoom: "12",
		});
	});

	test("rejects malformed area params", () => {
		expect(parseSettingsAreaPrefill("?area=1,2,3")).toBeNull();
		expect(parseSettingsAreaPrefill("?area=3,2,1,4")).toBeNull();
		expect(parseSettingsAreaPrefill("?area=1,nope,3,4")).toBeNull();
	});
});
