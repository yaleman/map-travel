import { expect, test } from "@playwright/test";

test("switches between trace and heat map layers without fetching track data", async ({
	page,
}) => {
	let mapObjectRequests = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/map-objects") {
			mapObjectRequests += 1;
		}
	});
	await page.goto("/");
	await expect(page.locator("#map canvas")).toBeVisible();
	await expect(page.locator("#map-mode")).toHaveValue("traces");
	await expect(page.locator("#track-heatmap-legend")).toBeHidden();

	const visibility = (layerId: string) =>
		page.evaluate(
			(id) =>
				(
					window as typeof window & {
						__mapTravelDebug?: { layerVisibility: (value: string) => string | undefined };
					}
				).__mapTravelDebug?.layerVisibility(id),
			layerId,
		);

	await expect.poll(() => visibility("tracks-line")).toBe("visible");
	await expect.poll(() => visibility("track-heatmap")).toBe("none");
	const requestsBeforeSwitch = mapObjectRequests;

	await page.locator("#map-mode").selectOption("heatmap");
	await expect(page.locator("#track-heatmap-legend")).toBeVisible();
	const radiusInput = page.locator("#heatmap-radius-metres");
	await expect(radiusInput).toBeVisible();
	await expect(radiusInput).toHaveValue("100");
	await expect(radiusInput).toHaveAttribute("min", "1");
	await expect(radiusInput).toHaveAttribute("max", "1000");
	await expect.poll(() => visibility("tracks-line")).toBe("none");
	await expect.poll(() => visibility("elevated-track-extrusions")).toBe("none");
	await expect.poll(() => visibility("selected-track-line")).toBe("none");
	await expect.poll(() => visibility("track-heatmap")).toBe("visible");
	await expect.poll(() => visibility("places-circle")).toBe("visible");
	expect(mapObjectRequests).toBe(requestsBeforeSwitch);

	const radiusResponse = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return (
			url.pathname === "/api/map-objects" &&
			url.searchParams.get("heatmap_radius_m") === "250"
		);
	});
	await radiusInput.fill("250");
	await radiusInput.blur();
	expect((await radiusResponse).status()).toBe(200);
	await expect(radiusInput).toHaveValue("250");
	expect(mapObjectRequests).toBe(requestsBeforeSwitch + 1);

	await page.locator("#map-mode").selectOption("traces");
	await expect(page.locator("#track-heatmap-legend")).toBeHidden();
	await expect(radiusInput).toBeHidden();
	await expect.poll(() => visibility("tracks-line")).toBe("visible");
	await expect.poll(() => visibility("elevated-track-extrusions")).toBe("visible");
	await expect.poll(() => visibility("selected-track-line")).toBe("visible");
	await expect.poll(() => visibility("track-heatmap")).toBe("none");
	expect(mapObjectRequests).toBe(requestsBeforeSwitch + 1);
});
