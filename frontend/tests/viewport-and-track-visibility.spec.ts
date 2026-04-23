import { expect, test } from "@playwright/test";

const BRISBANE_TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="map-travel-playwright" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Hideable Track</name>
    <trkseg>
      <trkpt lat="-27.4705" lon="153.0246">
        <time>2026-02-10T08:00:00Z</time>
      </trkpt>
      <trkpt lat="-27.4692" lon="153.0262">
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

	await page.locator("#gpx-file").setInputFiles({
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
		page.getByRole("button", { name: "Import GPX" }).click(),
	]);
	expect(trackImport.status()).toBe(201);

	await page.getByRole("button", { name: "Refresh" }).click();

	const detailPanel = page.locator("#detail-panel");
	await expect(detailPanel).toContainText("Hideable Track");
	await detailPanel.getByRole("button", { name: /Hideable Track/ }).click();
	await page.getByRole("button", { name: "Hide from map" }).click();
	await expect(
		page.getByRole("button", { name: "Show on map" }),
	).toBeVisible();

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
	await page.getByRole("button", { name: "Refresh" }).click();

	await expect(page.locator("#detail-panel")).toContainText("Sydney Harbour");
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
	await expect(sections.nth(0)).toContainText("Refresh");
	await expect(sections.nth(1)).toContainText("GPX file");

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
