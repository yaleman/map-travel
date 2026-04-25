export const AREA_EXTRACT_MAX_ZOOM = 12;

export interface TileBounds {
	minLon: number;
	minLat: number;
	maxLon: number;
	maxLat: number;
}

export interface MissingTilesResponse {
	missing: boolean;
	tile_zoom: number;
	missing_tile_count: number;
	bounds: [number, number, number, number] | null;
	max_zoom: number | null;
}

export interface SettingsAreaPrefill {
	bounds: TileBounds;
	label: string;
	maxZoom: string;
}

export function clampMissingTileZoom(zoom: number): number {
	return Math.max(0, Math.min(AREA_EXTRACT_MAX_ZOOM, Math.floor(zoom)));
}

export function missingTilesQueryString(
	bounds: TileBounds,
	zoom: number,
): string {
	const params = new URLSearchParams({
		min_lon: formatCoordinate(bounds.minLon),
		min_lat: formatCoordinate(bounds.minLat),
		max_lon: formatCoordinate(bounds.maxLon),
		max_lat: formatCoordinate(bounds.maxLat),
		tile_zoom: String(clampMissingTileZoom(zoom)),
	});
	return params.toString();
}

export function missingTilesSettingsUrl(
	recommendation: MissingTilesResponse,
	label = "Missing map detail",
): string {
	if (!recommendation.missing || !recommendation.bounds) {
		return "/settings";
	}
	const [minLon, minLat, maxLon, maxLat] = recommendation.bounds;
	const params = new URLSearchParams({
		area: [
			formatCoordinate(minLon),
			formatCoordinate(minLat),
			formatCoordinate(maxLon),
			formatCoordinate(maxLat),
		].join(","),
		max_zoom: String(
			clampMissingTileZoom(recommendation.max_zoom ?? recommendation.tile_zoom),
		),
		label,
	});
	return `/settings?${params.toString()}`;
}

export function parseSettingsAreaPrefill(
	search: string,
): SettingsAreaPrefill | null {
	const params = new URLSearchParams(search);
	const area = params.get("area");
	if (!area) {
		return null;
	}
	const values = area.split(",").map((value) => Number(value));
	if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
		return null;
	}
	const [minLon, minLat, maxLon, maxLat] = values;
	if (minLon >= maxLon || minLat >= maxLat) {
		return null;
	}
	const maxZoom = Number(params.get("max_zoom") ?? AREA_EXTRACT_MAX_ZOOM);
	if (!Number.isFinite(maxZoom)) {
		return null;
	}
	const clampedMaxZoom = clampMissingTileZoom(maxZoom);
	const label = params.get("label")?.trim() || "Missing map detail";
	return {
		bounds: { minLon, minLat, maxLon, maxLat },
		label,
		maxZoom: String(clampedMaxZoom),
	};
}

function formatCoordinate(value: number): string {
	return value.toFixed(6);
}
