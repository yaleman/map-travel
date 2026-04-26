import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	timeout: 120_000,
	outputDir: "../output/playwright/test-results",
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:9010",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	webServer: {
		command: "../scripts/run-playwright-server.sh",
		url: "http://127.0.0.1:9010",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
