#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const buildsMetadataUrl =
	process.env.MAP_TRAVEL_VENDOR_BUILDS_METADATA_URL ??
	"https://build-metadata.protomaps.dev/builds.json";
const styleBaseUrl =
	process.env.MAP_TRAVEL_VENDOR_STYLE_BASE_URL ??
	"https://npm-style.protomaps.dev/style.json";
const outputDir =
	process.env.MAP_TRAVEL_VENDOR_OUTPUT_DIR ??
	path.join(repoRoot, "vendor", "protomaps");
const maxGlyphCodePoint = Number.parseInt(
	process.env.MAP_TRAVEL_VENDOR_GLYPH_MAX_CODEPOINT ?? "65535",
	10,
);
const forceRefresh = process.env.MAP_TRAVEL_VENDOR_FORCE === "1";
const explicitBuildKey = process.env.MAP_TRAVEL_VENDOR_BUILD_KEY ?? "";

const spriteTargets = [
	["sprite.json", ".json"],
	["sprite.png", ".png"],
	["sprite@2x.json", "@2x.json"],
	["sprite@2x.png", "@2x.png"],
];

async function main() {
	if (!forceRefresh && (await hasCompleteVendoredBundle())) {
		console.log(`Using vendored basemap assets from ${path.relative(repoRoot, outputDir)}`);
		return;
	}

	const buildKey = explicitBuildKey || (await fetchLatestBuildKey());
	const styleUrl = protomapsStyleUrl(styleBaseUrl, buildKey);
	const style = await fetchJson(styleUrl);
	const spriteBaseUrl = asString(style.sprite, "style sprite URL");
	const glyphsTemplate = asString(style.glyphs, "style glyphs URL");
	const fontStacks = Array.from(collectStyleFontStacks(style)).sort();
	const glyphRanges = buildGlyphRanges(maxGlyphCodePoint);

	if (fontStacks.length === 0) {
		throw new Error("no font stacks were discovered in the vendored basemap style");
	}

	await mkdir(outputDir, { recursive: true });
	await writeJson(path.join(outputDir, "style.json"), style);

	for (const [filename, suffix] of spriteTargets) {
		await downloadFile(`${spriteBaseUrl}${suffix}`, path.join(outputDir, filename));
	}

	for (const fontStack of fontStacks) {
		const fontDir = path.join(outputDir, "fonts", fontStack);
		await mkdir(fontDir, { recursive: true });
		await mapConcurrent(glyphRanges, 16, async (range) => {
			const outputPath = path.join(fontDir, `${range}.pbf`);
			const fontUrl = glyphsTemplate
				.replace("{fontstack}", encodeURIComponent(fontStack))
				.replace("{range}", encodeURIComponent(range));
			await downloadFile(fontUrl, outputPath);
		});
	}

	await writeJson(path.join(outputDir, "manifest.json"), {
		buildKey,
		styleUrl,
		fontStacks,
		glyphRanges,
		generatedAt: new Date().toISOString(),
	});

	console.log(
		`Vendored basemap assets for ${buildKey} into ${path.relative(repoRoot, outputDir)}`,
	);
}

async function fetchLatestBuildKey() {
	const payload = await fetchJson(buildsMetadataUrl);
	if (!Array.isArray(payload) || payload.length === 0) {
		throw new Error(`no Protomaps builds were returned from ${buildsMetadataUrl}`);
	}
	const sorted = [...payload].sort((left, right) => {
		const leftUploaded = Date.parse(left.uploaded ?? "");
		const rightUploaded = Date.parse(right.uploaded ?? "");
		if (Number.isFinite(leftUploaded) && Number.isFinite(rightUploaded)) {
			return rightUploaded - leftUploaded;
		}
		return String(right.key ?? "").localeCompare(String(left.key ?? ""));
	});
	const buildKey = sorted[0]?.key;
	if (typeof buildKey !== "string" || buildKey.length === 0) {
		throw new Error("latest Protomaps build record did not include a key");
	}
	return buildKey;
}

function protomapsStyleUrl(baseUrl, buildKey) {
	const buildId = buildKey.replace(/\.pmtiles$/, "");
	const separator = baseUrl.includes("?") ? "&" : "?";
	return `${baseUrl}${separator}version=5.0.0&theme=light&tiles=${buildId}&lang=en`;
}

function buildGlyphRanges(maxCodePoint) {
	const ranges = [];
	for (let start = 0; start <= maxCodePoint; start += 256) {
		const end = Math.min(start + 255, maxCodePoint);
		ranges.push(`${start}-${end}`);
	}
	return ranges;
}

function collectStyleFontStacks(style) {
	const fonts = new Set();
	for (const layer of style.layers ?? []) {
		collectFontExpression(layer?.layout?.["text-font"], fonts);
	}
	return fonts;
}

function collectFontExpression(value, fonts) {
	if (typeof value === "string") {
		if (looksLikeFontName(value)) {
			fonts.add(value);
		}
		return;
	}
	if (!Array.isArray(value)) {
		return;
	}
	if (value[0] === "literal" && Array.isArray(value[1])) {
		for (const candidate of value[1]) {
			if (typeof candidate === "string" && looksLikeFontName(candidate)) {
				fonts.add(candidate);
			}
		}
		return;
	}
	for (const item of value) {
		collectFontExpression(item, fonts);
	}
}

function looksLikeFontName(value) {
	return /[A-Z]/.test(value) && /\s/.test(value) && !value.includes("_");
}

async function downloadFile(url, outputPath) {
	if (!forceRefresh && (await fileExists(outputPath))) {
		return;
	}
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	await writeFile(outputPath, bytes);
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	return response.json();
}

async function fileExists(filePath) {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function hasCompleteVendoredBundle() {
	let manifest;
	try {
		manifest = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8"));
	} catch {
		return false;
	}

	if (!Array.isArray(manifest.fontStacks) || !Array.isArray(manifest.glyphRanges)) {
		return false;
	}

	const requiredFiles = [
		"style.json",
		"sprite.json",
		"sprite.png",
		"sprite@2x.json",
		"sprite@2x.png",
		...manifest.fontStacks.flatMap((fontStack) =>
			manifest.glyphRanges.map((range) => path.join("fonts", fontStack, `${range}.pbf`)),
		),
	];

	return Promise.all(requiredFiles.map((file) => fileExists(path.join(outputDir, file)))).then(
		(results) => results.every(Boolean),
	);
}

async function writeJson(filePath, value) {
	await writeFile(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}

async function mapConcurrent(items, concurrency, worker) {
	const queue = [...items];
	const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
		while (queue.length > 0) {
			const next = queue.shift();
			if (typeof next === "undefined") {
				return;
			}
			await worker(next);
		}
	});
	await Promise.all(runners);
}

function asString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`missing ${label}`);
	}
	return value;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
