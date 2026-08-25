import { expect, test, type APIRequestContext } from "@playwright/test";

const BRISBANE_TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="map-travel-playwright" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Collection Track</name>
    <trkseg>
      <trkpt lat="-27.4705" lon="153.0246"><time>2026-02-10T08:00:00Z</time></trkpt>
      <trkpt lat="-27.4692" lon="153.0262"><time>2026-02-10T08:20:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>
`;

async function createCollection(
	request: APIRequestContext,
	name: string,
): Promise<string> {
	const response = await request.post("/api/collections", {
		data: { name, kind: "trip", starts_at: null, ends_at: null },
	});
	expect(response.ok()).toBeTruthy();
	return (await response.json()).id as string;
}

test("imports and edits a track's collection memberships", async ({
	page,
	request,
}) => {
	const firstCollectionId = await createCollection(request, "Morning walks");
	const secondCollectionId = await createCollection(request, "Weekend hikes");

	await page.goto("/");
	await page.locator("#filter-collections summary").click();
	await page
		.locator(`#filter-collections input[value="${firstCollectionId}"]`)
		.check();
	await page.locator("#open-import-dialog").click();
	const importDialog = page.locator("#import-dialog");
	await expect(
		importDialog.locator(
			`#import-collection-list input[value="${firstCollectionId}"]`,
		),
	).toBeChecked();
	await importDialog.locator("#import-collection-list summary").click();
	await page
		.locator("#import-collection-list input[aria-label='Search collections']")
		.fill("WEEKEND");
	await expect(
		page.locator(`#import-collection-list input[value="${firstCollectionId}"]`),
	).toBeHidden();
	await page
		.locator(`#import-collection-list input[value="${secondCollectionId}"]`)
		.check();
	await importDialog.locator("#gpx-file").setInputFiles({
		name: "collection-track.gpx",
		mimeType: "application/gpx+xml",
		buffer: Buffer.from(BRISBANE_TRACK_GPX),
	});

	const [importResponse] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/tracks/import") &&
				response.request().method() === "POST",
		),
		importDialog.getByRole("button", { name: "Import GPX" }).click(),
	]);
	expect(importResponse.status()).toBe(201);
	const importedTrack = (await importResponse.json()).tracks[0];
	expect(importedTrack.collection_ids.sort()).toEqual(
		[firstCollectionId, secondCollectionId].sort(),
	);

	const trackId = importedTrack.id as string;
	await page.goto(
		`/?selected=${trackId}#map=-27.46980,153.02510,12.00&object=track:${trackId}`,
	);
	await page.getByRole("button", { name: "Edit" }).click();
	await page.locator("#track-collection-selector summary").click();
	await expect(
		page.locator(`#track-edit-form input[value="${firstCollectionId}"]`),
	).toBeChecked();
	await expect(
		page.locator(`#track-edit-form input[value="${secondCollectionId}"]`),
	).toBeChecked();
	await page
		.locator(`#track-edit-form input[value="${firstCollectionId}"]`)
		.uncheck();

	const [patchResponse] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().endsWith(`/api/tracks/${trackId}`) &&
				response.request().method() === "PATCH",
		),
		page.locator("#track-edit-form").getByRole("button", { name: "Save" }).click(),
	]);
	expect(patchResponse.status()).toBe(200);
	expect((await patchResponse.json()).collection_ids).toEqual([secondCollectionId]);

	const firstFilterCheckbox = page.locator(
		`#filter-collections input[value="${firstCollectionId}"]`,
	);
	if (await firstFilterCheckbox.isChecked()) {
		await firstFilterCheckbox.uncheck();
	}
	const firstFilterResponse = page.waitForResponse(
		(response) =>
			response.url().includes("/api/map-objects") &&
			new URL(response.url()).searchParams.get("collection_ids") === firstCollectionId,
	);
	await page.locator("#filter-collections summary").click();
	await firstFilterCheckbox.check();
	expect((await firstFilterResponse).status()).toBe(200);
	const firstFiltered = await request.get(
		`/api/map-objects?min_lat=-28&min_lon=152&max_lat=-27&max_lon=154&object_type=track&collection_id=${firstCollectionId}`,
	);
	expect((await firstFiltered.json()).tracks).toEqual([]);

	const secondFiltered = await request.get(
		`/api/map-objects?min_lat=-28&min_lon=152&max_lat=-27&max_lon=154&object_type=track&collection_id=${secondCollectionId}`,
	);
	expect((await secondFiltered.json()).tracks.map((track: { id: string }) => track.id)).toEqual([trackId]);
});
