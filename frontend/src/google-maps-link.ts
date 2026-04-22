import type { ViewportFragmentState } from "./viewport-fragment";

export function googleMapsViewportUrl(
	state: ViewportFragmentState,
): string {
	return `https://www.google.com/maps/@${state.latitude.toFixed(5)},${state.longitude.toFixed(5)},${state.zoom.toFixed(2)}z`;
}
