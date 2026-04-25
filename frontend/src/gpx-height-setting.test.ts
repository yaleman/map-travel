import { describe, expect, test } from "vitest";

import { readRenderGpxHeight, writeRenderGpxHeight } from "./gpx-height-setting";

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

describe("GPX height rendering preference", () => {
	test("defaults to enabled when no stored value exists", () => {
		expect(readRenderGpxHeight(createStorage().storage)).toBe(true);
	});

	test("round-trips enabled state through storage", () => {
		const { storage } = createStorage();

		writeRenderGpxHeight(false, storage);
		expect(readRenderGpxHeight(storage)).toBe(false);

		writeRenderGpxHeight(true, storage);
		expect(readRenderGpxHeight(storage)).toBe(true);
	});

	test("falls back to enabled when storage reads fail", () => {
		const storage = {
			getItem: () => {
				throw new Error("storage unavailable");
			},
			setItem: () => undefined,
		};

		expect(readRenderGpxHeight(storage)).toBe(true);
	});

	test("ignores storage write failures", () => {
		const storage = {
			getItem: () => null,
			setItem: () => {
				throw new Error("storage unavailable");
			},
		};

		expect(() => writeRenderGpxHeight(false, storage)).not.toThrow();
	});
});
