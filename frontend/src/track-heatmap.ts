const EARTH_RADIUS_METERS = 6_371_008.8;
const EARTH_CIRCUMFERENCE_METERS = 2 * Math.PI * EARTH_RADIUS_METERS;
const MAX_MERCATOR_LATITUDE = 85.051_129;

type Position = [number, number];

export interface HeatmapTrack {
	id: string;
	geometry: GeoJSON.Geometry;
}

export interface TrackHeatmapProperties {
	weight: number;
}

interface HeatmapCell {
	coordinates: Position;
	weight: number;
}

export function buildTrackHeatmapFeatureCollection(
	tracks: HeatmapTrack[],
	hiddenTrackIds: ReadonlySet<string> = new Set(),
	spacingMeters = 100,
): GeoJSON.FeatureCollection<GeoJSON.Point, TrackHeatmapProperties> {
	if (!Number.isFinite(spacingMeters) || spacingMeters <= 0) {
		throw new Error("Heatmap spacing must be greater than zero.");
	}

	const cells = new Map<string, HeatmapCell>();
	for (const track of tracks) {
		if (hiddenTrackIds.has(track.id)) {
			continue;
		}
		for (const line of geometryLines(track.geometry)) {
			let previousCellKey: string | null = null;
			for (const sample of sampleLineByDistance(line, spacingMeters)) {
				const cell = geographicCell(sample, spacingMeters);
				if (cell.key === previousCellKey) {
					continue;
				}
				previousCellKey = cell.key;
				const existing = cells.get(cell.key);
				if (existing) {
					existing.weight += 1;
				} else {
					cells.set(cell.key, {
						coordinates: cell.coordinates,
						weight: 1,
					});
				}
			}
		}
	}

	return {
		type: "FeatureCollection",
		features: [...cells.values()].map((cell) => ({
			type: "Feature",
			properties: { weight: cell.weight },
			geometry: {
				type: "Point",
				coordinates: cell.coordinates,
			},
		})),
	};
}

export function sampleLineByDistance(
	coordinates: GeoJSON.Position[],
	spacingMeters = 100,
): Position[] {
	if (!Number.isFinite(spacingMeters) || spacingMeters <= 0) {
		throw new Error("Sample spacing must be greater than zero.");
	}
	const line = coordinates.filter(isValidPosition).map(toPosition);
	if (line.length === 0) {
		return [];
	}

	const samples: Position[] = [line[0]];
	let distanceToNextSample = spacingMeters;
	for (let index = 1; index < line.length; index += 1) {
		const start = line[index - 1];
		const end = line[index];
		const segmentMeters = distanceMeters(start, end);
		if (segmentMeters === 0) {
			continue;
		}

		let consumedMeters = 0;
		while (segmentMeters - consumedMeters >= distanceToNextSample) {
			consumedMeters += distanceToNextSample;
			samples.push(interpolatePosition(start, end, consumedMeters / segmentMeters));
			distanceToNextSample = spacingMeters;
		}
		distanceToNextSample -= segmentMeters - consumedMeters;
	}

	const end = line[line.length - 1];
	if (distanceMeters(samples[samples.length - 1], end) > 0.01) {
		samples.push(end);
	}
	return samples;
}

export function metersToPixels(
	meters: number,
	zoom: number,
	latitude: number,
): number {
	const clampedLatitude = Math.max(
		-MAX_MERCATOR_LATITUDE,
		Math.min(MAX_MERCATOR_LATITUDE, latitude),
	);
	const metersPerPixel =
		(EARTH_CIRCUMFERENCE_METERS * Math.cos(toRadians(clampedLatitude))) /
		(512 * 2 ** zoom);
	return meters / metersPerPixel;
}

function geometryLines(geometry: GeoJSON.Geometry): GeoJSON.Position[][] {
	if (geometry.type === "LineString") {
		return [geometry.coordinates];
	}
	if (geometry.type === "MultiLineString") {
		return geometry.coordinates;
	}
	return [];
}

function geographicCell(
	position: Position,
	cellSizeMeters: number,
): { key: string; coordinates: Position } {
	const latitudeStep = (cellSizeMeters / EARTH_RADIUS_METERS) * (180 / Math.PI);
	const latitudeIndex = Math.floor((position[1] + 90) / latitudeStep);
	const latitude = (latitudeIndex + 0.5) * latitudeStep - 90;
	const circumferenceAtLatitude = Math.max(
		cellSizeMeters,
		EARTH_CIRCUMFERENCE_METERS * Math.cos(toRadians(latitude)),
	);
	const longitudeStep = (cellSizeMeters / circumferenceAtLatitude) * 360;
	const normalizedLongitude = ((position[0] + 180) % 360 + 360) % 360;
	const longitudeIndex = Math.floor(normalizedLongitude / longitudeStep);
	const longitude = (longitudeIndex + 0.5) * longitudeStep - 180;
	return {
		key: `${latitudeIndex}:${longitudeIndex}`,
		coordinates: [longitude, latitude],
	};
}

function distanceMeters(start: Position, end: Position): number {
	const latitudeDelta = toRadians(end[1] - start[1]);
	const longitudeDelta = toRadians(shortestLongitudeDelta(start[0], end[0]));
	const startLatitude = toRadians(start[1]);
	const endLatitude = toRadians(end[1]);
	const haversine =
		Math.sin(latitudeDelta / 2) ** 2 +
		Math.cos(startLatitude) *
			Math.cos(endLatitude) *
			Math.sin(longitudeDelta / 2) ** 2;
	return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function interpolatePosition(start: Position, end: Position, ratio: number): Position {
	const longitude = start[0] + shortestLongitudeDelta(start[0], end[0]) * ratio;
	return [normalizeLongitude(longitude), start[1] + (end[1] - start[1]) * ratio];
}

function shortestLongitudeDelta(start: number, end: number): number {
	return ((end - start + 540) % 360) - 180;
}

function normalizeLongitude(longitude: number): number {
	return ((longitude + 540) % 360) - 180;
}

function isValidPosition(position: GeoJSON.Position): boolean {
	return (
		position.length >= 2 &&
		Number.isFinite(position[0]) &&
		Number.isFinite(position[1]) &&
		position[1] >= -90 &&
		position[1] <= 90
	);
}

function toPosition(position: GeoJSON.Position): Position {
	return [position[0], position[1]];
}

function toRadians(degrees: number): number {
	return (degrees * Math.PI) / 180;
}
