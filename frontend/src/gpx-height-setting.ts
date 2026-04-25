const STORAGE_KEY = "map-travel.render-gpx-height";

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export function readRenderGpxHeight(
	storageLike: StorageLike = window.localStorage,
): boolean {
	try {
		return storageLike.getItem(STORAGE_KEY) !== "false";
	} catch {
		return true;
	}
}

export function writeRenderGpxHeight(
	enabled: boolean,
	storageLike: StorageLike = window.localStorage,
): void {
	try {
		storageLike.setItem(STORAGE_KEY, String(enabled));
	} catch {
		// Ignore storage failures and keep the map usable.
	}
}
