export interface ViewportFragmentState {
	latitude: number;
	longitude: number;
	zoom: number;
}

interface HistoryLike {
	replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
}

interface LocationLike {
	pathname: string;
	search: string;
	hash?: string;
}

export function formatViewportFragment(
	state: ViewportFragmentState,
): string {
	return `map=${state.latitude.toFixed(5)},${state.longitude.toFixed(5)},${state.zoom.toFixed(2)}`;
}

export function parseViewportFragment(
	hash: string,
): ViewportFragmentState | null {
	const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!fragment.startsWith("map=")) {
		return null;
	}

	const [latitude, longitude, zoom] = fragment
		.slice(4)
		.split(",")
		.map((value) => Number(value));
	if (
		![latitude, longitude, zoom].every((value) => Number.isFinite(value)) ||
		latitude < -90 ||
		latitude > 90 ||
		longitude < -180 ||
		longitude > 180 ||
		zoom < 0
	) {
		return null;
	}

	return {
		latitude,
		longitude,
		zoom,
	};
}

export function writeViewportFragment(
	state: ViewportFragmentState,
	locationLike: LocationLike = window.location,
	historyLike: HistoryLike = window.history,
): void {
	const nextUrl = `${locationLike.pathname}${locationLike.search}#${formatViewportFragment(state)}`;
	historyLike.replaceState({}, "", nextUrl);
}

export function buildViewUrl(
	pathname: string,
	locationLike: LocationLike = window.location,
): string {
	return `${pathname}${locationLike.search}${locationLike.hash ?? ""}`;
}

export function createDebouncedViewportFragmentUpdater(
	commit: (state: ViewportFragmentState) => void,
	delayMs: number,
): (state: ViewportFragmentState) => void {
	let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

	return (state: ViewportFragmentState) => {
		if (timeoutId !== null) {
			globalThis.clearTimeout(timeoutId);
		}
		timeoutId = globalThis.setTimeout(() => {
			timeoutId = null;
			commit(state);
		}, delayMs);
	};
}
