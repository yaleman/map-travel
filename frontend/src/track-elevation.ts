export interface ElevatedTrackPoint {
	longitude: number;
	latitude: number;
	elevationMeters: number;
}

export type ElevatedTrackSegment = ElevatedTrackPoint[];

export interface ElevationRange {
	min: number;
	max: number;
}

export interface ElevationProfilePoint extends ElevatedTrackPoint {
	progress: number;
}

export interface ElevationProfileSegment {
	points: ElevationProfilePoint[];
}

export interface ElevationProfile {
	segments: ElevationProfileSegment[];
	range: ElevationRange;
	sampleCount: number;
}

export interface ElevatedTrackExtrusionInput {
	id: string;
	geometry: GeoJSON.Geometry;
	selected: boolean;
}

export interface ElevatedTrackExtrusionProperties {
	track_id: string;
	selected: boolean;
	height_m: number;
}

export interface ElevatedTrackExtrusionStats {
	featureCount: number;
	selectedFeatureCount: number;
	maxHeightM: number;
}

const RIBBON_WIDTH_METERS = 40;
const HALF_RIBBON_WIDTH_METERS = RIBBON_WIDTH_METERS / 2;
const METERS_PER_DEGREE_LATITUDE = 111_320;

export function extractElevatedTrackSegments(
	geometry: GeoJSON.Geometry,
): ElevatedTrackSegment[] {
	if (geometry.type === "LineString") {
		return extractElevatedLineSegments(geometry.coordinates);
	}
	if (geometry.type === "MultiLineString") {
		return geometry.coordinates.flatMap((coordinates) =>
			extractElevatedLineSegments(coordinates),
		);
	}
	return [];
}

export function trackElevationRange(
	geometry: GeoJSON.Geometry,
): ElevationRange | null {
	const elevations = extractElevatedTrackSegments(geometry)
		.flat()
		.map((point) => point.elevationMeters);
	if (elevations.length === 0) {
		return null;
	}
	return {
		min: Math.min(...elevations),
		max: Math.max(...elevations),
	};
}

export function formatElevationRange(range: ElevationRange): string {
	return `${Math.round(range.min)}-${Math.round(range.max)} m`;
}

export function trackElevationProfile(
	geometry: GeoJSON.Geometry,
): ElevationProfile | null {
	const segments = extractElevatedTrackSegments(geometry);
	const sampleCount = segments.reduce(
		(total, segment) => total + segment.length,
		0,
	);
	if (sampleCount < 2) {
		return null;
	}

	const range = trackElevationRange(geometry);
	if (!range) {
		return null;
	}

	const denominator = sampleCount - 1;
	let sampleIndex = 0;
	return {
		segments: segments.map((segment) => ({
			points: segment.map((point) => {
				const profilePoint = {
					...point,
					progress: sampleIndex / denominator,
				};
				sampleIndex += 1;
				return profilePoint;
			}),
		})),
		range,
		sampleCount,
	};
}

export function buildElevatedTrackExtrusionFeatureCollection(
	tracks: ElevatedTrackExtrusionInput[],
): GeoJSON.FeatureCollection<
	GeoJSON.Polygon,
	ElevatedTrackExtrusionProperties
> {
	return {
		type: "FeatureCollection",
		features: tracks.flatMap((track) =>
			extractElevatedTrackSegments(track.geometry).flatMap((segment) =>
				extrusionFeaturesForSegment(track, segment),
			),
		),
	};
}

export function elevatedTrackExtrusionStats(
	featureCollection: GeoJSON.FeatureCollection<
		GeoJSON.Polygon,
		ElevatedTrackExtrusionProperties
	>,
): ElevatedTrackExtrusionStats {
	const heights = featureCollection.features.map(
		(feature) => feature.properties.height_m,
	);
	return {
		featureCount: featureCollection.features.length,
		selectedFeatureCount: featureCollection.features.filter(
			(feature) => feature.properties.selected,
		).length,
		maxHeightM: heights.length ? Math.max(...heights) : 0,
	};
}

function extrusionFeaturesForSegment(
	track: ElevatedTrackExtrusionInput,
	segment: ElevatedTrackSegment,
): GeoJSON.Feature<GeoJSON.Polygon, ElevatedTrackExtrusionProperties>[] {
	const features: GeoJSON.Feature<
		GeoJSON.Polygon,
		ElevatedTrackExtrusionProperties
	>[] = [];
	for (let index = 1; index < segment.length; index += 1) {
		const feature = extrusionFeatureForPair(
			track,
			segment[index - 1],
			segment[index],
		);
		if (feature) {
			features.push(feature);
		}
	}
	return features;
}

function extrusionFeatureForPair(
	track: ElevatedTrackExtrusionInput,
	start: ElevatedTrackPoint,
	end: ElevatedTrackPoint,
): GeoJSON.Feature<GeoJSON.Polygon, ElevatedTrackExtrusionProperties> | null {
	const ring = ribbonRingForPair(start, end);
	if (!ring) {
		return null;
	}
	const height = (start.elevationMeters + end.elevationMeters) / 2;
	if (!Number.isFinite(height)) {
		return null;
	}
	return {
		type: "Feature",
		properties: {
			track_id: track.id,
			selected: track.selected,
			height_m: height,
		},
		geometry: {
			type: "Polygon",
			coordinates: [ring],
		},
	};
}

function ribbonRingForPair(
	start: ElevatedTrackPoint,
	end: ElevatedTrackPoint,
): GeoJSON.Position[] | null {
	const midLatitudeRadians =
		(((start.latitude + end.latitude) / 2) * Math.PI) / 180;
	const metersPerDegreeLongitude = Math.max(
		Math.abs(Math.cos(midLatitudeRadians)) * METERS_PER_DEGREE_LATITUDE,
		0.000_001,
	);
	const deltaXMeters =
		(end.longitude - start.longitude) * metersPerDegreeLongitude;
	const deltaYMeters =
		(end.latitude - start.latitude) * METERS_PER_DEGREE_LATITUDE;
	const lengthMeters = Math.hypot(deltaXMeters, deltaYMeters);
	if (lengthMeters < 0.01) {
		return null;
	}

	const normalXMeters = (-deltaYMeters / lengthMeters) * HALF_RIBBON_WIDTH_METERS;
	const normalYMeters = (deltaXMeters / lengthMeters) * HALF_RIBBON_WIDTH_METERS;
	const offsetLongitude = normalXMeters / metersPerDegreeLongitude;
	const offsetLatitude = normalYMeters / METERS_PER_DEGREE_LATITUDE;

	const startLeft: GeoJSON.Position = [
		start.longitude + offsetLongitude,
		start.latitude + offsetLatitude,
	];
	const endLeft: GeoJSON.Position = [
		end.longitude + offsetLongitude,
		end.latitude + offsetLatitude,
	];
	const endRight: GeoJSON.Position = [
		end.longitude - offsetLongitude,
		end.latitude - offsetLatitude,
	];
	const startRight: GeoJSON.Position = [
		start.longitude - offsetLongitude,
		start.latitude - offsetLatitude,
	];
	return [startLeft, endLeft, endRight, startRight, startLeft];
}

function extractElevatedLineSegments(
	coordinates: GeoJSON.Position[],
): ElevatedTrackSegment[] {
	const segments: ElevatedTrackSegment[] = [];
	let current: ElevatedTrackSegment = [];

	for (const coordinate of coordinates) {
		const point = elevatedPointFromPosition(coordinate);
		if (!point) {
			if (current.length >= 2) {
				segments.push(current);
			}
			current = [];
			continue;
		}
		current.push(point);
	}

	if (current.length >= 2) {
		segments.push(current);
	}
	return segments;
}

function elevatedPointFromPosition(
	coordinate: GeoJSON.Position,
): ElevatedTrackPoint | null {
	const [longitude, latitude, elevationMeters] = coordinate;
	if (
		!Number.isFinite(longitude) ||
		!Number.isFinite(latitude) ||
		!Number.isFinite(elevationMeters)
	) {
		return null;
	}
	return {
		longitude,
		latitude,
		elevationMeters,
	};
}
