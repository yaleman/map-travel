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
