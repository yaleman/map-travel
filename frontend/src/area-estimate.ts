const MAX_MERCATOR_LAT = 85.051129;

export interface AreaBounds {
	minLon: number;
	minLat: number;
	maxLon: number;
	maxLat: number;
}

export function estimateAreaExtractTiles(
	bounds: AreaBounds,
	maxZoom: number,
): number {
	let total = 0;
	for (let z = 0; z <= maxZoom; z += 1) {
		const [minX, maxX, minY, maxY] = tileRangeForBounds(bounds, z);
		total += (maxX - minX + 1) * (maxY - minY + 1);
	}
	return total;
}

function tileRangeForBounds(
	bounds: AreaBounds,
	z: number,
): [number, number, number, number] {
	const tiles = 2 ** z;
	const minX = Math.floor(lonToTileX(bounds.minLon, tiles));
	const maxX = Math.ceil(lonToTileX(bounds.maxLon, tiles)) - 1;
	const minY = Math.floor(latToTileY(bounds.maxLat, tiles));
	const maxY = Math.ceil(latToTileY(bounds.minLat, tiles)) - 1;
	const maxIndex = tiles - 1;
	return [
		clamp(minX, 0, maxIndex),
		clamp(maxX, 0, maxIndex),
		clamp(minY, 0, maxIndex),
		clamp(maxY, 0, maxIndex),
	];
}

function lonToTileX(lon: number, tiles: number): number {
	return ((clamp(lon, -180, 180) + 180) / 360) * tiles;
}

function latToTileY(lat: number, tiles: number): number {
	const clamped = clamp(lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
	const radians = (clamped * Math.PI) / 180;
	const projected = Math.log(Math.tan(radians) + 1 / Math.cos(radians));
	return ((1 - projected / Math.PI) / 2) * tiles;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
