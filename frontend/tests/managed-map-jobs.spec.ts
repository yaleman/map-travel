import { expect, test } from "@playwright/test";

const build = {
	key: "20260421.pmtiles",
	version: null,
	size: 1024,
	uploaded: "2026-08-12T00:00:00Z",
	md5_sum: null,
	b3_sum: null,
};

function failedJob(id: string) {
	return {
		id,
		kind: "world-to-6",
		status: "failed",
		build_key: build.key,
		chunk_id: "world-to-6",
		archive_id: null,
		error_message: "download failed",
		current_step: "Failed",
		progress_percent: 50,
		segments_done: 1,
		segments_total: 2,
		created_at: "2026-08-12T00:00:00Z",
		updated_at: "2026-08-12T00:00:00Z",
		started_at: "2026-08-12T00:00:00Z",
		finished_at: "2026-08-12T00:00:00Z",
	};
}

test("retries and removes failed managed-map jobs from Settings", async ({
	page,
}) => {
	let jobs = [failedJob("failed-retry"), failedJob("failed-remove")];
	let retryRequests = 0;
	let removeRequests = 0;

	await page.route("**/api/settings/maps/builds", async (route) => {
		await route.fulfill({
			json: { selected_build_key: build.key, builds: [build] },
		});
	});
	await page.route("**/api/settings/maps/local", async (route) => {
		await route.fulfill({
			json: { selected_build_key: build.key, chunks: [] },
		});
	});
	await page.route("**/api/settings/maps/jobs", async (route) => {
		await route.fulfill({ json: { jobs } });
	});
	await page.route(
		"**/api/settings/maps/jobs/failed-retry/retry",
		async (route) => {
			retryRequests += 1;
			jobs = jobs.filter((job) => job.id !== "failed-retry");
			await route.fulfill({
				status: 201,
				json: { job_id: "replacement-job", chunk_id: "world-to-6" },
			});
		},
	);
	await page.route("**/api/settings/maps/jobs/failed-remove", async (route) => {
		removeRequests += 1;
		jobs = jobs.filter((job) => job.id !== "failed-remove");
		await route.fulfill({ status: 204 });
	});

	await page.goto("/settings");
	await expect(
		page.locator('[data-retry-job-id="failed-retry"]'),
	).toBeVisible();
	await expect(
		page.locator('[data-remove-job-id="failed-remove"]'),
	).toBeVisible();

	await page.locator('[data-retry-job-id="failed-retry"]').click();
	await expect(page.locator('[data-retry-job-id="failed-retry"]')).toBeHidden();
	expect(retryRequests).toBe(1);

	await page.locator('[data-remove-job-id="failed-remove"]').click();
	await expect(
		page.locator('[data-remove-job-id="failed-remove"]'),
	).toBeHidden();
	await expect(page.getByText("No map jobs yet.")).toBeVisible();
	expect(removeRequests).toBe(1);
});
