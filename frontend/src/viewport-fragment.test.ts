import { describe, expect, test, vi } from "vitest";

import {
	createDebouncedViewportFragmentUpdater,
	formatViewportFragment,
	writeViewportFragment,
} from "./viewport-fragment";

describe("formatViewportFragment", () => {
	test("formats latitude, longitude, and zoom into a stable fragment", () => {
		expect(
			formatViewportFragment({
				latitude: -27.4698,
				longitude: 153.0251,
				zoom: 12.3456,
			}),
		).toBe("map=-27.46980,153.02510,12.35");
	});
});

describe("writeViewportFragment", () => {
	test("replaces the current url hash without changing the path", () => {
		const replaceState = vi.fn();

		writeViewportFragment(
			{
				latitude: -27.4698,
				longitude: 153.0251,
				zoom: 9.5,
			},
			{
				pathname: "/settings",
				search: "?foo=bar",
			},
			{ replaceState },
		);

		expect(replaceState).toHaveBeenCalledWith(
			{},
			"",
			"/settings?foo=bar#map=-27.46980,153.02510,9.50",
		);
	});
});

describe("createDebouncedViewportFragmentUpdater", () => {
	test("emits only the latest viewport after 250ms of inactivity", () => {
		vi.useFakeTimers();
		const commit = vi.fn();
		const schedule = createDebouncedViewportFragmentUpdater(commit, 250);

		schedule({
			latitude: -27.4,
			longitude: 153,
			zoom: 5,
		});
		schedule({
			latitude: -27.5,
			longitude: 153.1,
			zoom: 6,
		});

		vi.advanceTimersByTime(249);
		expect(commit).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(commit).toHaveBeenCalledWith({
			latitude: -27.5,
			longitude: 153.1,
			zoom: 6,
		});

		vi.useRealTimers();
	});
});
