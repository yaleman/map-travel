import { expect, test } from "@playwright/test";

const BRISBANE_TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="map-travel-playwright" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Editable Track</name>
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

test("renames places and tracks from the drawer", async ({ page, request }) => {
	const createPlaceResponse = await request.post("/api/places", {
		data: {
			name: "Editable Place",
			category: "camp",
			notes: "Original note",
			latitude: -27.4698,
			longitude: 153.0251,
			visit_start: "2026-02-10T00:00:00Z",
			visit_end: "2026-02-10T01:00:00Z",
			collection_ids: [],
			tag_names: [],
		},
	});
	expect(createPlaceResponse.ok()).toBeTruthy();

	await page.goto("/");

	const detailPanel = page.locator("#detail-panel");
	const refreshButton = page.getByRole("button", { name: "Refresh" });

	await refreshButton.click();
	await expect(detailPanel).toContainText("Editable Place");
	await detailPanel.getByRole("button", { name: /Editable Place/ }).click();
	await page.getByRole("button", { name: "Edit" }).click();
	await page.locator("#place-edit-form input[name='name']").fill("Renamed Place");
	await page.locator("#place-edit-form textarea[name='notes']").fill("Updated place note");
	await page
		.locator("#place-edit-form input[name='visit_start']")
		.fill("2026-02-11T09:30");
	await page
		.locator("#place-edit-form input[name='visit_end']")
		.fill("2026-02-11T10:45");
	const expectedVisitStart = new Date("2026-02-11T09:30").toISOString();
	const expectedVisitEnd = new Date("2026-02-11T10:45").toISOString();

	const [placePatch] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().includes("/api/places/") &&
				response.request().method() === "PATCH",
		),
		page.locator("#place-edit-form").getByRole("button", { name: "Save" }).click(),
	]);
	expect(placePatch.status()).toBe(200);
	const placePatchPayload = await placePatch.json();
	expect(new Date(placePatchPayload.visit_start).toISOString()).toBe(
		expectedVisitStart,
	);
	expect(new Date(placePatchPayload.visit_end).toISOString()).toBe(expectedVisitEnd);
	await expect(detailPanel).toContainText("Renamed Place");
	await expect(detailPanel).toContainText("Updated place note");

	await page.locator("#gpx-file").setInputFiles({
		name: "editable-track.gpx",
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
	const importedTrack = await trackImport.json();
	const trackId = importedTrack.tracks[0].id;

	await page.goto(
		`/?selected=${trackId}#map=-27.46980,153.02510,12.00&object=track:${trackId}`,
	);
	await expect(detailPanel).toContainText("Editable Track");
	await page.getByRole("button", { name: "Edit" }).click();
	await page.locator("#track-edit-form input[name='title']").fill("Renamed Track");
	await page.locator("#track-edit-form textarea[name='notes']").fill("Updated track note");

	const [trackPatch] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().includes("/api/tracks/") &&
				response.request().method() === "PATCH",
		),
		page.locator("#track-edit-form").getByRole("button", { name: "Save" }).click(),
	]);
	expect(trackPatch.status()).toBe(200);
	await expect(detailPanel).toContainText("Renamed Track");
	await expect(detailPanel).toContainText("Updated track note");
});

test("deletes places and tracks from the edit flow after confirmation", async ({
	page,
	request,
}) => {
	const createPlaceResponse = await request.post("/api/places", {
		data: {
			name: "Disposable Place",
			category: "camp",
			notes: "Delete me",
			latitude: -27.4698,
			longitude: 153.0251,
			visit_start: null,
			visit_end: null,
			collection_ids: [],
			tag_names: [],
		},
	});
	expect(createPlaceResponse.ok()).toBeTruthy();

	await page.goto("/");

	const detailPanel = page.locator("#detail-panel");
	const refreshButton = page.getByRole("button", { name: "Refresh" });

	await refreshButton.click();
	await expect(detailPanel).toContainText("Disposable Place");
	await detailPanel.getByRole("button", { name: /Disposable Place/ }).click();
	await page.getByRole("button", { name: "Edit" }).click();
	await page.locator("#place-edit-form").getByRole("button", { name: "Delete" }).click();
	await expect(detailPanel).toContainText("Delete this place from the database?");

	const [placeDelete] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().includes("/api/places/") &&
				response.request().method() === "DELETE",
		),
		page.getByRole("button", { name: "Confirm" }).click(),
	]);
	expect(placeDelete.status()).toBe(204);
	await expect(detailPanel).not.toContainText("Disposable Place");

	await page.locator("#gpx-file").setInputFiles({
		name: "disposable-track.gpx",
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
	const importedTrack = await trackImport.json();
	const trackId = importedTrack.tracks[0].id;

	await page.goto(
		`/?selected=${trackId}#map=-27.46980,153.02510,12.00&object=track:${trackId}`,
	);
	await expect(detailPanel).toContainText("Editable Track");
	await page.getByRole("button", { name: "Edit" }).click();
	await page.locator("#track-edit-form").getByRole("button", { name: "Delete" }).click();
	await expect(detailPanel).toContainText("Delete this track from the database?");

	const [trackDelete] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().includes("/api/tracks/") &&
				response.request().method() === "DELETE",
		),
		page.getByRole("button", { name: "Confirm" }).click(),
	]);
	expect(trackDelete.status()).toBe(204);
	await expect(detailPanel).not.toContainText("Editable Track");
});
