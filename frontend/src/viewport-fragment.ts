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
}

export function formatViewportFragment(
	state: ViewportFragmentState,
): string {
	return `map=${state.latitude.toFixed(5)},${state.longitude.toFixed(5)},${state.zoom.toFixed(2)}`;
}

export function writeViewportFragment(
	state: ViewportFragmentState,
	locationLike: LocationLike = window.location,
	historyLike: HistoryLike = window.history,
): void {
	const nextUrl = `${locationLike.pathname}${locationLike.search}#${formatViewportFragment(state)}`;
	historyLike.replaceState({}, "", nextUrl);
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
