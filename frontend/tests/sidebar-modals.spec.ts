import { expect, test } from "@playwright/test";

const MODAL_TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="map-travel-playwright" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Modal Track</name>
    <trkseg>
      <trkpt lat="-27.4705" lon="153.0246" />
      <trkpt lat="-27.4692" lon="153.0262" />
    </trkseg>
  </trk>
</gpx>`;

test("uses focused modal workflows for collections and GPX imports", async ({
	page,
}) => {
	await page.goto("/");

	const sidebar = page.locator("#workspace-sidebar-content");
	await expect(sidebar.locator("#collection-list")).toHaveCount(0);
	await expect(sidebar.locator("#collection-form")).toHaveCount(0);
	await expect(sidebar.locator("#import-form")).toHaveCount(0);
	await expect(page.locator("#open-import-dialog")).toBeVisible();
	await expect(page.locator("#open-collection-dialog")).toBeVisible();

	const importDialog = page.locator("#import-dialog");
	await page.locator("#open-import-dialog").click();
	await expect(importDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(importDialog).not.toBeVisible();

	const collectionDialog = page.locator("#collection-dialog");
	await page.locator("#open-collection-dialog").click();
	await expect(collectionDialog).toBeVisible();
	await collectionDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(collectionDialog).not.toBeVisible();

	await page.locator("#open-collection-dialog").click();
	await collectionDialog.locator("#collection-name").fill("Modal journeys");
	await collectionDialog.locator("#collection-kind").selectOption("general");
	const [collectionResponse] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/collections") &&
				response.request().method() === "POST",
		),
		collectionDialog
			.getByRole("button", { name: "Create Collection" })
			.click(),
	]);
	expect(collectionResponse.status()).toBe(201);
	const collectionId = (await collectionResponse.json()).id as string;
	await expect(collectionDialog).not.toBeVisible();

	await page.locator("#filter-collections summary").click();
	const collectionFilter = page.locator(
		`#filter-collections input[value="${collectionId}"]`,
	);
	await expect(collectionFilter).toBeAttached();
	await collectionFilter.check();

	await page.locator("#open-import-dialog").click();
	await expect(
		importDialog.locator(
			`#import-collection-list input[value="${collectionId}"]`,
		),
	).toBeChecked();
	await importDialog.locator("#gpx-file").setInputFiles({
		name: "modal-track.gpx",
		mimeType: "application/gpx+xml",
		buffer: Buffer.from(MODAL_TRACK_GPX),
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
	expect((await importResponse.json()).tracks[0].collection_ids).toEqual([
		collectionId,
	]);
	await expect(importDialog).not.toBeVisible();

	await page.locator("#open-import-dialog").click();
	await importDialog.locator("#gpx-file").setInputFiles({
		name: "broken.gpx",
		mimeType: "application/gpx+xml",
		buffer: Buffer.from("<gpx><trk></gpx>"),
	});
	const [failedImportResponse] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/tracks/import") &&
				response.request().method() === "POST",
		),
		importDialog.getByRole("button", { name: "Import GPX" }).click(),
	]);
	expect(failedImportResponse.status()).toBe(400);
	await expect(importDialog).toBeVisible();
	await expect(importDialog.locator("#import-dialog-status")).toContainText(
		"GPX parsing failed",
	);
});
