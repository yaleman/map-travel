const STORAGE_KEY = "map-travel.workspace-sidebar-collapsed";

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export function readWorkspaceSidebarCollapsed(
	storageLike: StorageLike = window.localStorage,
): boolean {
	try {
		return storageLike.getItem(STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

export function writeWorkspaceSidebarCollapsed(
	collapsed: boolean,
	storageLike: StorageLike = window.localStorage,
): void {
	try {
		storageLike.setItem(STORAGE_KEY, String(collapsed));
	} catch {
		// Ignore storage failures and keep the UI responsive.
	}
}
