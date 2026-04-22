import { describe, expect, test } from "vitest";

import {
	readWorkspaceSidebarCollapsed,
	writeWorkspaceSidebarCollapsed,
} from "./workspace-sidebar";

function createStorage(): {
	storage: {
		getItem: (key: string) => string | null;
		setItem: (key: string, value: string) => void;
	};
	values: Map<string, string>;
} {
	const values = new Map<string, string>();
	return {
		storage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
		},
		values,
	};
}

describe("workspace sidebar persistence", () => {
	test("defaults to expanded when no stored value exists", () => {
		expect(readWorkspaceSidebarCollapsed(createStorage().storage)).toBe(false);
	});

	test("round-trips collapsed state through storage", () => {
		const { storage } = createStorage();

		writeWorkspaceSidebarCollapsed(true, storage);
		expect(readWorkspaceSidebarCollapsed(storage)).toBe(true);

		writeWorkspaceSidebarCollapsed(false, storage);
		expect(readWorkspaceSidebarCollapsed(storage)).toBe(false);
	});
});
