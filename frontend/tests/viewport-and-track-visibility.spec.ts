import { expect, test } from "@playwright/test";

const BRISBANE_TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="map-travel-playwright" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Hideable Track</name>
    <trkseg>
      <trkpt lat="-27.4705" lon="153.0246">
        <ele>100</ele>
        <time>2026-02-10T08:00:00Z</time>
      </trkpt>
      <trkpt lat="-27.4692" lon="153.0262">
        <ele>160</ele>
        <time>2026-02-10T08:20:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>
`;

test("updates the fragment on viewport changes and keeps hidden tracks in the object list", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator("#open-google-maps")).toHaveAttribute(
		"href",
		"https://www.google.com/maps/@-27.46980,153.02510,3.00z",
	);

	const canvas = page.locator("#map canvas");
	await expect(canvas).toBeVisible();
	const box = await canvas.boundingBox();
	if (!box) {
		throw new Error("Map canvas bounding box was unavailable");
	}

	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2, {
		steps: 10,
	});
	await page.mouse.up();

	await expect
		.poll(() => page.evaluate(() => window.location.hash), {
			timeout: 2_000,
		})
		.toMatch(/^#map=-?\d+\.\d+,-?\d+\.\d+,\d+\.\d+$/);
	await expect
		.poll(
			() => page.locator("#open-google-maps").getAttribute("href"),
			{ timeout: 2_000 },
		)
		.toMatch(
			/^https:\/\/www\.google\.com\/maps\/@-?\d+\.\d+,-?\d+\.\d+,\d+\.\d+z$/,
		);

	await page.locator("#open-import-dialog").click();
	const importDialog = page.locator("#import-dialog");
	await importDialog.locator("#gpx-file").setInputFiles({
		name: "hideable-track.gpx",
		mimeType: "application/gpx+xml",
		buffer: Buffer.from(BRISBANE_TRACK_GPX),
	});
	const [trackImport] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/tracks/import") &&
				response.request().method() === "POST",
		),
		importDialog.getByRole("button", { name: "Import GPX" }).click(),
	]);
	expect(trackImport.status()).toBe(201);
	const importedTrack = await trackImport.json();
	const trackId = importedTrack.tracks[0].id;

	await page.getByRole("button", { name: "Refresh" }).click();

	const detailPanel = page.locator("#detail-panel");
	await expect(detailPanel).toContainText("Hideable Track");
	await detailPanel.getByRole("button", { name: /Hideable Track/ }).click();
	await expect(detailPanel).toContainText("100-160 m");
	await expect(detailPanel).toContainText("Elevation profile");
	await expect(detailPanel.locator(".elevation-relief-map")).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					Boolean(
						(window as typeof window & { __mapTravelDebug?: { hasLayer: (id: string) => boolean } })
							.__mapTravelDebug?.hasLayer("elevated-track-extrusions"),
					),
			),
		)
		.toBe(true);
	await expect
		.poll(() =>
			page.evaluate(() => {
				const stats = (
					window as typeof window & {
						__mapTravelDebug?: {
							elevatedTrackExtrusionStats: () => {
								featureCount: number;
								selectedFeatureCount: number;
								maxHeightM: number;
							};
						};
					}
				).__mapTravelDebug?.elevatedTrackExtrusionStats();
				return {
					featureCount: stats?.featureCount ?? 0,
					selectedFeatureCount: stats?.selectedFeatureCount ?? 0,
					maxHeightM: stats?.maxHeightM ?? 0,
				};
			}),
		)
		.toEqual({ featureCount: 1, selectedFeatureCount: 1, maxHeightM: 130 });
	await page.getByRole("button", { name: "Hide from map" }).click();
	await expect(
		page.getByRole("button", { name: "Show on map" }),
	).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as typeof window & {
						__mapTravelDebug?: {
							elevatedTrackExtrusionStats: () => { featureCount: number };
						};
					}).__mapTravelDebug?.elevatedTrackExtrusionStats().featureCount ?? 0,
			),
		)
		.toBe(0);
	await page.getByRole("button", { name: "Show on map" }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as typeof window & {
						__mapTravelDebug?: {
							elevatedTrackExtrusionStats: () => { featureCount: number };
						};
					}).__mapTravelDebug?.elevatedTrackExtrusionStats().featureCount ?? 0,
			),
		)
		.toBe(1);

	await page.getByRole("button", { name: "Settings" }).click();
	const renderGpxHeight = page.locator("#render-gpx-height");
	await expect(renderGpxHeight).toBeChecked();
	await renderGpxHeight.setChecked(false);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as typeof window & {
						__mapTravelDebug?: {
							elevatedTrackExtrusionStats: () => { featureCount: number };
						};
					}).__mapTravelDebug?.elevatedTrackExtrusionStats().featureCount ?? 0,
			),
		)
		.toBe(0);
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("map-travel.render-gpx-height")),
		)
		.toBe("false");

	await page.reload();
	await expect(page.locator("#render-gpx-height")).not.toBeChecked();
	await page.locator("#render-gpx-height").setChecked(true);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as typeof window & {
						__mapTravelDebug?: {
							elevatedTrackExtrusionStats: () => { featureCount: number };
						};
					}).__mapTravelDebug?.elevatedTrackExtrusionStats().featureCount ?? 0,
			),
		)
		.toBe(1);
	await page.getByRole("button", { name: "Back To Map" }).click();

	await page.locator("#map").click({
		position: {
			x: 16,
			y: 16,
		},
	});

	await expect(detailPanel).toContainText("In View");
	await expect(
		detailPanel.getByRole("button", { name: /Hideable Track/ }),
	).toBeVisible();

	await page.goto(`/#map=0.00000,0.00000,12.00&object=track:${trackId}`);
	await page.reload();
	await expect(detailPanel).toContainText("Hideable Track");
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as typeof window & {
						__mapTravelDebug?: {
							elevatedTrackExtrusionStats: () => {
								featureCount: number;
								selectedFeatureCount: number;
								maxHeightM: number;
							};
						};
					}).__mapTravelDebug?.elevatedTrackExtrusionStats() ?? {
						featureCount: 0,
						selectedFeatureCount: 0,
						maxHeightM: 0,
					},
			),
		)
		.toEqual({ featureCount: 1, selectedFeatureCount: 1, maxHeightM: 130 });
});

test("warns about missing local map tiles and preselects a settings extract", async ({
	page,
}) => {
	await page.route("**/api/basemap", async (route) => {
		await route.fulfill({
			json: {
				enabled: true,
				style_url: null,
				tile_type: "mvt",
				min_zoom: 0,
				max_zoom: 12,
				bounds: [-180, -85.051129, 180, 85.051129],
				message: null,
			},
		});
	});
	await page.route("**/api/basemap/missing-tiles?*", async (route) => {
		await route.fulfill({
			json: {
				missing: true,
				tile_zoom: 12,
				missing_tile_count: 5,
				bounds: [135.878906, 34.016242, 136.230469, 34.307144],
				max_zoom: 12,
			},
		});
	});

	await page.goto("/#map=34.01624,136.05469,12.30");
	const warning = page.locator("#missing-map-tiles");
	await expect(warning).toBeVisible();
	await expect(warning).toHaveAttribute("href", /\/settings\?area=/);
	await expect(warning).toHaveAttribute("target", "_blank");

	const popupPromise = page.waitForEvent("popup");
	await warning.click();
	const settingsPage = await popupPromise;
	await settingsPage.waitForLoadState("networkidle");
	await expect(settingsPage).toHaveURL(/\/settings\?area=/);
	await expect(settingsPage.locator("#area-label")).toHaveValue(
		"Missing map detail",
	);
	await expect(settingsPage.locator("#area-max-zoom")).toHaveValue("12");
	await expect(settingsPage.locator("#area-selection-status")).toContainText(
		"34.016",
	);
	await expect(settingsPage.locator("#area-selection-status")).toContainText(
		"136.230",
	);
	await expect(
		settingsPage.getByRole("button", { name: "Create extract" }),
	).toBeEnabled();
});

test("hides the missing tile warning when local coverage is complete", async ({
	page,
}) => {
	await page.route("**/api/basemap", async (route) => {
		await route.fulfill({
			json: {
				enabled: true,
				style_url: null,
				tile_type: "mvt",
				min_zoom: 0,
				max_zoom: 12,
				bounds: [-180, -85.051129, 180, 85.051129],
				message: null,
			},
		});
	});
	await page.route("**/api/basemap/missing-tiles?*", async (route) => {
		await route.fulfill({
			json: {
				missing: false,
				tile_zoom: 12,
				missing_tile_count: 0,
				bounds: null,
				max_zoom: null,
			},
		});
	});

	await page.goto("/#map=34.01624,136.05469,12.30");
	await expect(page.locator("#missing-map-tiles")).toBeHidden();
});

test("restores the viewport from the fragment on reload", async ({
	page,
	request,
}) => {
	const createPlaceResponse = await request.post("/api/places", {
		data: {
			name: "Sydney Harbour",
			category: "city",
			notes: "Viewport restore target",
			latitude: -33.8688,
			longitude: 151.2093,
			visit_start: null,
			visit_end: null,
			collection_ids: [],
			tag_names: [],
		},
	});
	expect(createPlaceResponse.ok()).toBeTruthy();

	await page.goto("/#map=-33.86880,151.20930,12.00");
	await page.reload();

	await expect(page.locator("#detail-panel")).toContainText("Sydney Harbour");
});

test("renders initial viewport objects on first load without moving the map", async ({
	page,
	request,
}) => {
	await page.addInitScript(() => {
		const browserWindow = window as typeof window & {
			__replaceStateCalls: number;
		};
		const replaceState = history.replaceState.bind(history);
		browserWindow.__replaceStateCalls = 0;
		history.replaceState = (...args: Parameters<History["replaceState"]>) => {
			browserWindow.__replaceStateCalls += 1;
			return replaceState(...args);
		};
	});

	const createPlaceResponse = await request.post("/api/places", {
		data: {
			name: "Initial Map Place",
			category: "city",
			notes: "Visible on first load",
			latitude: -27.1234,
			longitude: 153.4567,
			visit_start: null,
			visit_end: null,
			collection_ids: [],
			tag_names: [],
		},
	});
	expect(createPlaceResponse.ok()).toBeTruthy();

	const [initialObjectsResponse] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().includes("/api/map-objects") &&
				response.request().method() === "GET",
		),
		page.goto("/#map=-27.12340,153.45670,12.00"),
	]);
	const initialObjects = await initialObjectsResponse.json();
	expect(initialObjects.places).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "Initial Map Place" }),
		]),
	);
	const canvas = page.locator("#map canvas");
	await expect(canvas).toBeVisible();
	const box = await canvas.boundingBox();
	if (!box) {
		throw new Error("Map canvas bounding box was unavailable");
	}
	await page.waitForTimeout(750);
	expect(
		await page.evaluate(
			() =>
				(window as typeof window & { __replaceStateCalls: number })
					.__replaceStateCalls,
		),
	).toBeLessThan(10);

	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

	const detailPanel = page.locator("#detail-panel");
	await expect(detailPanel).toContainText("Initial Map Place");
	await expect(detailPanel.getByRole("button", { name: "Copy link" })).toBeVisible();
});

test("adds selected objects to the fragment and copies deep links", async ({
	page,
	request,
}) => {
	const createPlaceResponse = await request.post("/api/places", {
		data: {
			name: "Deep Link Place",
			category: "city",
			notes: "Copy this place",
			latitude: -27.4698,
			longitude: 153.0251,
			visit_start: null,
			visit_end: null,
			collection_ids: [],
			tag_names: [],
		},
	});
	expect(createPlaceResponse.ok()).toBeTruthy();
	const place = await createPlaceResponse.json();

	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: (value: string) => {
					(window as typeof window & { __copiedLink?: string }).__copiedLink =
						value;
					return Promise.resolve();
				},
			},
		});
	});

	await page.goto("/");
	const detailPanel = page.locator("#detail-panel");
	await page.getByRole("button", { name: "Refresh" }).click();
	await detailPanel.getByRole("button", { name: /Deep Link Place/ }).click();

	await expect
		.poll(() => page.evaluate(() => window.location.hash), {
			timeout: 2_000,
		})
		.toContain(`object=place:${place.id}`);

	await detailPanel.getByRole("button", { name: "Copy link" }).click();
	const copiedLink = await page.evaluate(
		() => (window as typeof window & { __copiedLink?: string }).__copiedLink,
	);
	expect(copiedLink).toContain(`object=place:${place.id}`);

	await page.goto(copiedLink ?? "");
	await expect(detailPanel).toContainText("Deep Link Place");
	await expect(detailPanel.getByRole("button", { name: "Copy link" })).toBeVisible();

	await page.reload();
	await expect(detailPanel).toContainText("Deep Link Place");
	await expect(detailPanel.getByRole("button", { name: "Copy link" })).toBeVisible();
});

test("simplifies the workspace sidebar and persists collapsed state", async ({
	page,
}) => {
	await page.goto("/");

	const sidebar = page.locator("#workspace-sidebar");
	const sidebarContent = page.locator("#workspace-sidebar-content");
	const sections = sidebarContent.locator(".section");

	await expect(sidebar).not.toContainText("v1");
	await expect(sidebar).not.toContainText("Basemap");
	await expect(page.locator(".brand h1")).toContainText("Map Travel");
	await expect(sections.nth(0)).toContainText("Add place");
	await expect(sections.nth(0)).toContainText("Import GPX");
	await expect(sections.nth(0)).toContainText("Create Collection");
	await expect(sections.nth(0)).toContainText("Refresh");
	await expect(sections.nth(1)).toContainText("Filters");
	await expect(sidebarContent).not.toContainText("GPX file");

	await page.getByRole("button", { name: "Collapse sidebar" }).click();
	await expect(page.locator("#workspace-shell")).toHaveClass(/sidebar-collapsed/);
	await expect(sidebarContent).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Expand sidebar" }),
	).toBeVisible();
	await expect(page.locator("#collapsed-add-place")).toBeVisible();
	await expect(page.locator("#collapsed-open-settings")).toBeVisible();

	await page.reload();
	await expect(page.locator("#workspace-shell")).toHaveClass(/sidebar-collapsed/);
	await expect(sidebarContent).toBeHidden();
	await expect(page.locator("#collapsed-add-place")).toBeVisible();
	await expect(page.locator("#collapsed-open-settings")).toBeVisible();

	await page.getByRole("button", { name: "Expand sidebar" }).click();
	await expect(page.locator("#workspace-shell")).not.toHaveClass(
		/sidebar-collapsed/,
	);
	await expect(sidebarContent).toBeVisible();
});
