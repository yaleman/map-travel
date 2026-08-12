import { expect, test } from "@playwright/test";

const METADATA_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Creator" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>File Metadata Name</name>
    <desc>File metadata description</desc>
    <author><name>Trail Author</name></author>
    <keywords>walk, coastal</keywords>
    <link href="https://example.com/guide"><text>Guide</text><type>text/html</type></link>
  </metadata>
  <trk>
    <name>Track Metadata Name</name>
    <cmt>Track comment</cmt>
    <src>GPS logger</src>
    <type>hiking</type>
    <number>42</number>
    <trkseg>
      <trkpt lat="-27.4705" lon="153.0246" />
      <trkpt lat="-27.4692" lon="153.0262" />
    </trkseg>
  </trk>
</gpx>`;

test("shows imported GPX metadata in the track drawer", async ({ page }) => {
	await page.goto("/");
	await page.locator("#gpx-file").setInputFiles({
		name: "metadata-track.gpx",
		mimeType: "application/gpx+xml",
		buffer: Buffer.from(METADATA_GPX),
	});
	const [response] = await Promise.all([
		page.waitForResponse(
			(candidate) =>
				candidate.url().endsWith("/api/tracks/import") &&
				candidate.request().method() === "POST",
		),
		page.getByRole("button", { name: "Import GPX" }).click(),
	]);
	expect(response.status()).toBe(201);
	const trackId = (await response.json()).tracks[0].id as string;

	await page.goto(
		`/?selected=${trackId}#map=-27.46980,153.02510,12.00&object=track:${trackId}`,
	);
	const detailPanel = page.locator("#detail-panel");
	await expect(detailPanel).toContainText("Track Metadata Name");
	await expect(detailPanel).toContainText("File Metadata Name");
	await expect(detailPanel).toContainText("File metadata description");
	await expect(detailPanel).toContainText("Trail Author");
	await expect(detailPanel).toContainText("GPS logger");
	await expect(detailPanel).toContainText("hiking");
	await expect(detailPanel).toContainText("42");
	await expect(detailPanel.getByRole("link", { name: "Guide" })).toHaveAttribute(
		"href",
		"https://example.com/guide",
	);
});
