export interface ViewportCenter {
	latitude: number;
	longitude: number;
}

export interface ViewportTrackLike {
	id: string;
	title: string | null;
	original_filename?: string | null;
	notes?: string | null;
	min_lat: number;
	min_lon: number;
	max_lat: number;
	max_lon: number;
}

export interface ViewportPlaceLike {
	id: string;
	name: string;
	category?: string | null;
	notes?: string | null;
	latitude: number;
	longitude: number;
}

export interface ViewportObjectSummary {
	id: string;
	objectType: "track" | "place";
	title: string;
	distanceMeters: number;
}

export interface FilteredViewportObjects<
	TTrack extends ViewportTrackLike,
	TPlace extends ViewportPlaceLike,
> {
	tracks: TTrack[];
	places: TPlace[];
}

export function filterViewportObjects<
	TTrack extends ViewportTrackLike,
	TPlace extends ViewportPlaceLike,
>(
	query: string,
	tracks: TTrack[],
	places: TPlace[],
): FilteredViewportObjects<TTrack, TPlace> {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return { tracks, places };
	}

	return {
		tracks: tracks.filter((track) =>
			matchesAny(needle, [
				track.title,
				track.original_filename,
				track.notes,
			]),
		),
		places: places.filter((place) =>
			matchesAny(needle, [place.name, place.category, place.notes]),
		),
	};
}

export function sortViewportObjectsByDistance(
	center: ViewportCenter,
	tracks: ViewportTrackLike[],
	places: ViewportPlaceLike[],
): ViewportObjectSummary[] {
	const items = [
		...tracks.map((track) => ({
			id: track.id,
			objectType: "track" as const,
			title: track.title ?? "Untitled track",
			distanceMeters: haversineDistanceMeters(center, {
				latitude: (track.min_lat + track.max_lat) / 2,
				longitude: (track.min_lon + track.max_lon) / 2,
			}),
		})),
		...places.map((place) => ({
			id: place.id,
			objectType: "place" as const,
			title: place.name,
			distanceMeters: haversineDistanceMeters(center, {
				latitude: place.latitude,
				longitude: place.longitude,
			}),
		})),
	];

	return items.sort((left, right) => left.distanceMeters - right.distanceMeters);
}

function matchesAny(needle: string, values: Array<string | null | undefined>): boolean {
	return values.some((value) => value?.toLowerCase().includes(needle) ?? false);
}

function haversineDistanceMeters(
	left: ViewportCenter,
	right: ViewportCenter,
): number {
	const earthRadiusMeters = 6_371_000;
	const latitudeDelta = toRadians(right.latitude - left.latitude);
	const longitudeDelta = toRadians(right.longitude - left.longitude);
	const leftLatitude = toRadians(left.latitude);
	const rightLatitude = toRadians(right.latitude);

	const a =
		Math.sin(latitudeDelta / 2) ** 2 +
		Math.cos(leftLatitude) *
			Math.cos(rightLatitude) *
			Math.sin(longitudeDelta / 2) ** 2;
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return earthRadiusMeters * c;
}

function toRadians(value: number): number {
	return (value * Math.PI) / 180;
}
