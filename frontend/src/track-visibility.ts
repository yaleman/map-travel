export interface TrackVisibilityTrack {
	id: string;
}

export function filterVisibleTracks<T extends TrackVisibilityTrack>(
	tracks: T[],
	hiddenTrackIds: ReadonlySet<string>,
): T[] {
	return tracks.filter((track) => !hiddenTrackIds.has(track.id));
}
