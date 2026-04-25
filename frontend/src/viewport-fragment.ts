export interface ViewportFragmentState {
	latitude: number;
	longitude: number;
	zoom: number;
	selectedObject?: ViewportFragmentSelectedObject | null;
}

export interface ViewportFragmentSelectedObject {
	id: string;
	objectType: "track" | "place";
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
	const mapFragment = `map=${state.latitude.toFixed(5)},${state.longitude.toFixed(5)},${state.zoom.toFixed(2)}`;
	if (!state.selectedObject) {
		return mapFragment;
	}
	return `${mapFragment}&object=${state.selectedObject.objectType}:${encodeURIComponent(state.selectedObject.id)}`;
}

export function parseViewportFragment(
	hash: string,
): ViewportFragmentState | null {
	const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!fragment.startsWith("map=")) {
		return null;
	}

	const params = new URLSearchParams(fragment);
	const mapValue = params.get("map");
	if (!mapValue) {
		return null;
	}

	const [latitude, longitude, zoom] = mapValue
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

	const state: ViewportFragmentState = {
		latitude,
		longitude,
		zoom,
	};

	const selectedObject = parseSelectedObject(params.get("object"));
	if (selectedObject) {
		state.selectedObject = selectedObject;
	}

	return state;
}

export function writeViewportFragment(
	state: ViewportFragmentState,
	locationLike: LocationLike = window.location,
	historyLike: HistoryLike = window.history,
): void {
	const currentSelectedObject =
		state.selectedObject === undefined
			? parseViewportFragment(locationLike.hash ?? "")?.selectedObject
			: state.selectedObject;
	const nextUrl = `${locationLike.pathname}${locationLike.search}#${formatViewportFragment({
		...state,
		selectedObject: currentSelectedObject,
	})}`;
	const currentUrl = `${locationLike.pathname}${locationLike.search}${locationLike.hash ?? ""}`;
	if (nextUrl === currentUrl) {
		return;
	}
	historyLike.replaceState({}, "", nextUrl);
}

function parseSelectedObject(
	value: string | null,
): ViewportFragmentSelectedObject | null {
	if (!value) {
		return null;
	}
	const separatorIndex = value.indexOf(":");
	if (separatorIndex < 0) {
		return null;
	}
	const objectType = value.slice(0, separatorIndex);
	const id = value.slice(separatorIndex + 1);
	if ((objectType !== "track" && objectType !== "place") || !id) {
		return null;
	}
	return {
		objectType,
		id,
	};
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
