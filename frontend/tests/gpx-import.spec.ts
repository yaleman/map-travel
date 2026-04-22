import { expect, test } from "@playwright/test";

function largeGpx(): string {
	let body = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="map-travel-playwright" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Large Browser Track</name>
    <trkseg>
`;

	for (let index = 0; index < 35_000; index += 1) {
		const latitude = -43.7219 + index * 0.00001;
		const longitude = 170.0937 + index * 0.00001;
		body += `      <trkpt lat="${latitude.toFixed(5)}" lon="${longitude.toFixed(5)}"><time>2026-02-10T08:00:00Z</time></trkpt>\n`;
	}

	body += `    </trkseg>
  </trk>
</gpx>
`;
	return body;
}

test("imports a large GPX file through the browser", async ({ page }) => {
	const gpx = largeGpx();
	expect(gpx.length).toBeGreaterThan(2_000_000);

	await page.goto("/");

	const upload = page.locator("#gpx-file");
	const importButton = page.getByRole("button", { name: "Import GPX" });

	const [response] = await Promise.all([
		page.waitForResponse(
			(resp) =>
				resp.url().endsWith("/api/tracks/import") &&
				resp.request().method() === "POST",
		),
		upload.setInputFiles({
			name: "large-browser-track.gpx",
			mimeType: "application/gpx+xml",
			buffer: Buffer.from(gpx),
		}),
		importButton.click(),
	]);

	expect(response.status()).toBe(201);
	await expect(page.locator("#detail-panel")).toContainText(
		"GPX import complete. The track is now on the map.",
	);
});
