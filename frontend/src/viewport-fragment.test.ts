import { describe, expect, test, vi } from "vitest";

import {
	buildViewUrl,
	createDebouncedViewportFragmentUpdater,
	formatViewportFragment,
	parseViewportFragment,
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

	test("formats the selected object into the map fragment", () => {
		expect(
			formatViewportFragment({
				latitude: -27.4698,
				longitude: 153.0251,
				zoom: 12.3456,
				selectedObject: {
					objectType: "place",
					id: "place 1",
				},
			}),
		).toBe("map=-27.46980,153.02510,12.35&object=place:place%201");
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

	test("preserves the current selected object when updating only the viewport", () => {
		const replaceState = vi.fn();

		writeViewportFragment(
			{
				latitude: -27.4698,
				longitude: 153.0251,
				zoom: 9.5,
			},
			{
				pathname: "/",
				search: "",
				hash: "#map=-27.00000,153.00000,3.00&object=track:track-1",
			},
			{ replaceState },
		);

		expect(replaceState).toHaveBeenCalledWith(
			{},
			"",
			"/#map=-27.46980,153.02510,9.50&object=track:track-1",
		);
	});

	test("does not touch history when the fragment is already current", () => {
		const replaceState = vi.fn();

		writeViewportFragment(
			{
				latitude: -27.4698,
				longitude: 153.0251,
				zoom: 9.5,
				selectedObject: {
					objectType: "track",
					id: "track-1",
				},
			},
			{
				pathname: "/",
				search: "",
				hash: "#map=-27.46980,153.02510,9.50&object=track:track-1",
			},
			{ replaceState },
		);

		expect(replaceState).not.toHaveBeenCalled();
	});
});

describe("parseViewportFragment", () => {
	test("parses a valid map fragment into a viewport state", () => {
		expect(parseViewportFragment("#map=-27.46980,153.02510,9.50")).toEqual({
			latitude: -27.4698,
			longitude: 153.0251,
			zoom: 9.5,
		});
	});

	test("parses the selected object from the map fragment", () => {
		expect(
			parseViewportFragment(
				"#map=-27.46980,153.02510,9.50&object=place:place%201",
			),
		).toEqual({
			latitude: -27.4698,
			longitude: 153.0251,
			zoom: 9.5,
			selectedObject: {
				objectType: "place",
				id: "place 1",
			},
		});
	});

	test("rejects invalid fragments", () => {
		expect(parseViewportFragment("#wat=1,2,3")).toBeNull();
		expect(parseViewportFragment("#map=200,153.02510,9.50")).toBeNull();
		expect(parseViewportFragment("#map=-27.46980,nope,9.50")).toBeNull();
	});
});

describe("buildViewUrl", () => {
	test("preserves the active fragment when switching screens", () => {
		expect(
			buildViewUrl("/settings", {
				pathname: "/",
				search: "?foo=bar",
				hash: "#map=-27.46980,153.02510,9.50",
			}),
		).toBe("/settings?foo=bar#map=-27.46980,153.02510,9.50");
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
