import maplibregl, {
	type Map as MapGL,
	type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { googleMapsViewportUrl } from "./google-maps-link";
import {
	readRenderGpxHeight,
	writeRenderGpxHeight,
} from "./gpx-height-setting";
import {
	missingTilesQueryString,
	missingTilesSettingsUrl,
	parseSettingsAreaPrefill,
	type MissingTilesResponse,
	type SettingsAreaPrefill,
} from "./missing-tiles";
import { displayTrackColor } from "./track-display";
import {
	buildElevatedTrackExtrusionFeatureCollection,
	elevatedTrackExtrusionStats,
	formatElevationRange,
	trackElevationProfile,
	trackElevationRange,
	type ElevationProfile,
	type ElevatedTrackExtrusionProperties,
	type ElevatedTrackExtrusionStats,
} from "./track-elevation";
import { filterVisibleTracks } from "./track-visibility";
import {
	buildViewUrl,
	createDebouncedViewportFragmentUpdater,
	parseViewportFragment,
	writeViewportFragment,
	type ViewportFragmentState,
} from "./viewport-fragment";
import {
	filterViewportObjects,
	sortViewportObjectsByDistance,
} from "./viewport-objects";
import {
	readWorkspaceSidebarCollapsed,
	writeWorkspaceSidebarCollapsed,
} from "./workspace-sidebar";
import { renderCollectionMultiSelect } from "./collection-multi-select";
import "./styles.css";

type CollectionKind = "trip" | "future" | "past" | "general";
type ObjectType = "track" | "place";
type ViewMode = "workspace" | "settings";

interface CollectionRecord {
	id: string;
	name: string;
	kind: CollectionKind;
	starts_at: string | null;
	ends_at: string | null;
	is_public: boolean;
}

interface PlaceRecord {
	id: string;
	name: string;
	category: string | null;
	notes: string | null;
	latitude: number;
	longitude: number;
	visit_start: string | null;
	visit_end: string | null;
	is_public: boolean;
}

interface TrackRecord {
	id: string;
	title: string | null;
	original_filename: string | null;
	gpx_metadata: TrackGpxMetadata | null;
	notes: string | null;
	geometry_json: string;
	min_lat: number;
	min_lon: number;
	max_lat: number;
	max_lon: number;
	distance_m: number | null;
	start_time: string | null;
	end_time: string | null;
	collection_ids: string[];
}

interface TrackGpxMetadata {
	file_name: string | null;
	file_description: string | null;
	creator: string | null;
	file_time: string | null;
	keywords: string | null;
	author: string | null;
	comment: string | null;
	source: string | null;
	track_type: string | null;
	number: number | null;
	links: GpxLinkMetadata[];
}

interface GpxLinkMetadata {
	href: string;
	text: string | null;
	media_type: string | null;
}

interface MapObjectsResponse {
	places: PlaceRecord[];
	tracks: TrackRecord[];
}

interface BasemapConfig {
	enabled: boolean;
	style_url: string | null;
	tile_type: string | null;
	min_zoom: number | null;
	max_zoom: number | null;
	bounds: [number, number, number, number] | null;
	message: string | null;
}

interface FiltersState {
	objectType: "" | ObjectType;
	collectionIds: string[];
	tag: string;
	startsAfter: string;
	endsBefore: string;
}

interface PendingPlaceState {
	latitude: number;
	longitude: number;
}

interface MapsBuildRecord {
	key: string;
	version: string | null;
	size: number;
	uploaded: string;
	md5_sum: string | null;
	b3_sum: string | null;
}

interface MapsBuildsResponse {
	selected_build_key: string | null;
	builds: MapsBuildRecord[];
}

interface MapsArchiveRecord {
	id: string;
	build_key: string;
	relative_path: string;
	tile_type: string;
	min_zoom: number;
	max_zoom: number;
	min_lon: number;
	min_lat: number;
	max_lon: number;
	max_lat: number;
	file_size_bytes: number;
}

interface MapsChunkRecord {
	id: string;
	label: string;
	kind: string;
	min_lon: number | null;
	min_lat: number | null;
	max_lon: number | null;
	max_lat: number | null;
	max_zoom: number;
	enabled: boolean;
	display_order: number;
	stale: boolean;
	selected_build_ready: boolean;
	latest_job: MapsJobRecord | null;
	archives: MapsArchiveRecord[];
}

interface MapsLocalResponse {
	selected_build_key: string | null;
	chunks: MapsChunkRecord[];
}

interface MapsJobRecord {
	id: string;
	kind: string;
	status: string;
	build_key: string;
	chunk_id: string | null;
	archive_id: string | null;
	error_message: string | null;
	current_step: string;
	progress_percent: number;
	segments_done: number;
	segments_total: number;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	finished_at: string | null;
}

interface MapsJobsResponse {
	jobs: MapsJobRecord[];
}

interface SettingsState {
	isBusy: boolean;
	builds: MapsBuildRecord[];
	chunks: MapsChunkRecord[];
	jobs: MapsJobRecord[];
	selectedBuildKey: string;
}

interface AreaSelectionState {
	start: { lng: number; lat: number } | null;
	end: { lng: number; lat: number } | null;
}

interface AreaExtractFormState {
	label: string;
	maxZoom: string;
}

interface SelectedMapObjectState {
	id: string;
	objectType: ObjectType;
}

interface MapTravelDebug {
	elevatedTrackExtrusionStats: () => ElevatedTrackExtrusionStats;
	hasLayer: (id: string) => boolean;
}

declare global {
	interface Window {
		__mapTravelDebug?: MapTravelDebug;
	}
}

const workspaceScreen = must<HTMLElement>("#workspace-screen");
const workspaceShell = must<HTMLElement>("#workspace-shell");
const workspaceSidebar = must<HTMLElement>("#workspace-sidebar");
const workspaceSidebarContent = must<HTMLElement>("#workspace-sidebar-content");
const workspaceSidebarCollapsedTools = must<HTMLElement>(
	"#workspace-sidebar-collapsed-tools",
);
const settingsScreen = must<HTMLElement>("#settings-screen");
const detailPanel = must<HTMLDivElement>("#detail-panel");
const importForm = must<HTMLFormElement>("#import-form");
const gpxFileInput = must<HTMLInputElement>("#gpx-file");
const importCollectionList = must<HTMLDivElement>("#import-collection-list");
const collectionForm = must<HTMLFormElement>("#collection-form");
const collectionNameInput = must<HTMLInputElement>("#collection-name");
const collectionKindSelect = must<HTMLSelectElement>("#collection-kind");
const collectionList = must<HTMLDivElement>("#collection-list");
const filterObjectType = must<HTMLSelectElement>("#filter-object-type");
const filterCollections = must<HTMLDivElement>("#filter-collections");
const filterTag = must<HTMLInputElement>("#filter-tag");
const filterStartsAfter = must<HTMLInputElement>("#filter-starts-after");
const filterEndsBefore = must<HTMLInputElement>("#filter-ends-before");
const toggleAddPlaceButton = must<HTMLButtonElement>("#toggle-add-place");
const collapsedAddPlaceButton = must<HTMLButtonElement>("#collapsed-add-place");
const refreshMapButton = must<HTMLButtonElement>("#refresh-map");
const toggleSidebarButton = must<HTMLButtonElement>("#toggle-sidebar");
const expandSidebarButton = must<HTMLButtonElement>("#expand-sidebar");
const openSettingsButton = must<HTMLButtonElement>("#open-settings");
const collapsedOpenSettingsButton = must<HTMLButtonElement>(
	"#collapsed-open-settings",
);
const closeSettingsButton = must<HTMLButtonElement>("#close-settings");
const openGoogleMapsLink = must<HTMLAnchorElement>("#open-google-maps");
const missingMapTilesLink = must<HTMLAnchorElement>("#missing-map-tiles");
const rightPanelSearchForm = must<HTMLFormElement>("#right-panel-search-form");
const rightPanelSearchInput = must<HTMLInputElement>("#right-panel-search");
const settingsContent = must<HTMLDivElement>("#settings-content");
const settingsMapDetail = must<HTMLSpanElement>("#settings-map-detail");

const defaultStyle: StyleSpecification = {
	version: 8,
	sources: {},
	layers: [
		{
			id: "background",
			type: "background",
			paint: {
				"background-color": "#dce7df",
			},
		},
	],
};

let workspaceMap: MapGL;
let settingsMap: MapGL | null = null;
let currentBasemapConfig: BasemapConfig | null = null;
let collections: CollectionRecord[] = [];
let lastData: MapObjectsResponse = { places: [], tracks: [] };
let globalSearchResults: MapObjectsResponse | null = null;
let addPlaceMode = false;
let pendingPlace: PendingPlaceState | null = null;
let areaSelectionMode = false;
let areaSelection: AreaSelectionState = { start: null, end: null };
let areaExtractForm: AreaExtractFormState = {
	label: "Regional detail",
	maxZoom: "8",
};
let selectedMapObject: SelectedMapObjectState | null = null;
const hiddenTrackIds = new Set<string>();
let currentView: ViewMode = getViewFromLocation();
let workspaceSidebarCollapsed = readWorkspaceSidebarCollapsed();
let renderGpxHeight = readRenderGpxHeight();
let settingsRefreshTimer: number | null = null;
let missingTilesTimer: number | null = null;
let missingTilesRequestSequence = 0;
let lastAppliedSettingsPrefillSearch = "";
let pendingSettingsAreaFit = false;
let elevatedTrackExtrusionData: GeoJSON.FeatureCollection<
	GeoJSON.Polygon,
	ElevatedTrackExtrusionProperties
> =
	buildElevatedTrackExtrusionFeatureCollection([]);
const scheduleViewportFragmentUpdate = createDebouncedViewportFragmentUpdater(
	writeWorkspaceFragment,
	250,
);

const settingsState: SettingsState = {
	isBusy: false,
	builds: [],
	chunks: [],
	jobs: [],
	selectedBuildKey: "",
};

const filters: FiltersState = {
	objectType: "",
	collectionIds: [],
	tag: "",
	startsAfter: "",
	endsBefore: "",
};

applyWorkspaceSidebarState();
void bootstrap();

async function bootstrap(): Promise<void> {
	const basemap = await applyBasemapConfig();
	currentBasemapConfig = basemap;
	const initialFragment = parseViewportFragment(window.location.hash);
	selectedMapObject = initialFragment?.selectedObject ?? null;
	const initialWorkspaceViewport = initialFragment ?? {
		latitude: -27.4698,
		longitude: 153.0251,
		zoom: 3,
	};

	workspaceMap = new maplibregl.Map({
		container: "map",
		style: basemap.style_url ?? defaultStyle,
		center: [
			initialWorkspaceViewport.longitude,
			initialWorkspaceViewport.latitude,
		],
		zoom: initialWorkspaceViewport.zoom,
	});
	installMapTravelDebug();
	updateGoogleMapsLink(initialWorkspaceViewport);
	workspaceMap.addControl(new maplibregl.NavigationControl(), "top-right");
	workspaceMap.on("load", () => {
		ensureWorkspaceOverlayLayers();
		void refreshMapData();
		scheduleMissingTilesCheck();
	});
	workspaceMap.on("moveend", () => {
		void refreshMapData();
		scheduleMissingTilesCheck();
	});
	workspaceMap.on("move", () => {
		const viewport = {
			latitude: workspaceMap.getCenter().lat,
			longitude: workspaceMap.getCenter().lng,
			zoom: workspaceMap.getZoom(),
		};
		scheduleViewportFragmentUpdate(viewport);
		updateGoogleMapsLink(viewport);
	});
	workspaceMap.on("click", (event) => {
		if (addPlaceMode) {
			openPlaceDrawer({
				latitude: Number(event.lngLat.lat.toFixed(6)),
				longitude: Number(event.lngLat.lng.toFixed(6)),
			});
			return;
		}
		const clickedFeatures = workspaceMap.queryRenderedFeatures(event.point, {
			layers: ["tracks-line", "places-circle"],
		});
		if (clickedFeatures.length === 0) {
			renderDrawerEmpty();
		}
	});

	wireEventHandlers();
	applySettingsAreaPrefillFromLocation(true);
	if (selectedMapObject) {
		void renderSelectedMapObjectById(selectedMapObject);
	}
	await refreshCollections();
	await renderView(false);
	scheduleInitialMapDataRefresh();
}

function updateGoogleMapsLink(state: {
	latitude: number;
	longitude: number;
	zoom: number;
}): void {
	openGoogleMapsLink.href = googleMapsViewportUrl(state);
}

function scheduleMissingTilesCheck(): void {
	if (missingTilesTimer !== null) {
		window.clearTimeout(missingTilesTimer);
	}
	missingTilesTimer = window.setTimeout(() => {
		missingTilesTimer = null;
		void refreshMissingTilesWarning();
	}, 400);
}

async function refreshMissingTilesWarning(): Promise<void> {
	if (!workspaceMap || !workspaceMap.isStyleLoaded()) {
		return;
	}
	if (!currentBasemapConfig?.enabled) {
		hideMissingTilesWarning();
		return;
	}

	const bounds = workspaceMap.getBounds();
	const query = missingTilesQueryString(
		{
			minLon: bounds.getWest(),
			minLat: bounds.getSouth(),
			maxLon: bounds.getEast(),
			maxLat: bounds.getNorth(),
		},
		workspaceMap.getZoom(),
	);
	const requestSequence = (missingTilesRequestSequence += 1);
	try {
		const recommendation = await fetchJson<MissingTilesResponse>(
			`/api/basemap/missing-tiles?${query}`,
		);
		if (requestSequence !== missingTilesRequestSequence) {
			return;
		}
		updateMissingTilesWarning(recommendation);
	} catch (error) {
		console.error("Could not check local map tile coverage", error);
		hideMissingTilesWarning();
	}
}

function updateMissingTilesWarning(
	recommendation: MissingTilesResponse,
): void {
	if (!recommendation.missing || !recommendation.bounds) {
		hideMissingTilesWarning();
		return;
	}
	missingMapTilesLink.href = missingTilesSettingsUrl(recommendation);
	missingMapTilesLink.hidden = false;
}

function hideMissingTilesWarning(): void {
	missingMapTilesLink.hidden = true;
	missingMapTilesLink.href = "/settings";
}

function installMapTravelDebug(): void {
	window.__mapTravelDebug = {
		elevatedTrackExtrusionStats: () =>
			elevatedTrackExtrusionStats(elevatedTrackExtrusionData),
		hasLayer: (id: string) => Boolean(workspaceMap.getLayer(id)),
	};
}

function scheduleInitialMapDataRefresh(attempt = 0): void {
	window.setTimeout(() => {
		if (!workspaceMap.isStyleLoaded()) {
			if (attempt < 40) {
				scheduleInitialMapDataRefresh(attempt + 1);
			}
			return;
		}

		ensureWorkspaceOverlayLayers();
		void refreshMapData();
	}, 50);
}

function writeWorkspaceFragment(state: ViewportFragmentState): void {
	writeViewportFragment({
		...state,
		selectedObject: selectedMapObject,
	});
}

function currentWorkspaceFragmentState(): ViewportFragmentState {
	const center = workspaceMap.getCenter();
	return {
		latitude: center.lat,
		longitude: center.lng,
		zoom: workspaceMap.getZoom(),
		selectedObject: selectedMapObject,
	};
}

function selectMapObject(object: SelectedMapObjectState): void {
	selectedMapObject = object;
	updateWorkspaceSelectionSources();
	updateElevatedTrackExtrusions();
	writeWorkspaceFragment(currentWorkspaceFragmentState());
}

function clearSelectedMapObject(): void {
	selectedMapObject = null;
	updateWorkspaceSelectionSources();
	updateElevatedTrackExtrusions();
	writeWorkspaceFragment(currentWorkspaceFragmentState());
}

async function copySelectedObjectLink(button: HTMLButtonElement): Promise<void> {
	await navigator.clipboard.writeText(selectedObjectLink());
	button.textContent = "Copied";
	window.setTimeout(() => {
		button.textContent = "Copy link";
	}, 1_500);
}

function selectedObjectLink(): string {
	writeWorkspaceFragment(currentWorkspaceFragmentState());
	return window.location.href;
}

function applyWorkspaceSidebarState(): void {
	workspaceShell.classList.toggle("sidebar-collapsed", workspaceSidebarCollapsed);
	workspaceSidebar.classList.toggle(
		"workspace-sidebar-collapsed",
		workspaceSidebarCollapsed,
	);
	workspaceSidebarContent.toggleAttribute("hidden", workspaceSidebarCollapsed);
	workspaceSidebarCollapsedTools.toggleAttribute(
		"hidden",
		!workspaceSidebarCollapsed,
	);
	toggleSidebarButton.setAttribute(
		"aria-expanded",
		String(!workspaceSidebarCollapsed),
	);
	expandSidebarButton.setAttribute(
		"aria-expanded",
		String(!workspaceSidebarCollapsed),
	);
}

function toggleAddPlaceMode(): void {
	addPlaceMode = !addPlaceMode;
	pendingPlace = null;
	updateModeUi();
	if (!addPlaceMode) {
		renderDrawerEmpty();
	} else {
		updateDrawerMessage("Click on the map to drop a new place.");
	}
}

function setWorkspaceSidebarCollapsed(collapsed: boolean): void {
	if (workspaceSidebarCollapsed === collapsed) {
		return;
	}
	workspaceSidebarCollapsed = collapsed;
	writeWorkspaceSidebarCollapsed(workspaceSidebarCollapsed);
	applyWorkspaceSidebarState();
	if (currentView === "workspace") {
		workspaceMap?.resize();
	}
}

function wireEventHandlers(): void {
	importForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const file = gpxFileInput.files?.[0];
		if (!file) {
			updateDrawerMessage("Choose a GPX file before importing.");
			return;
		}

		const formData = new FormData();
		formData.set("file", file);
		for (const collectionId of new FormData(importForm).getAll("collection_ids")) {
			formData.append("collection_ids", collectionId);
		}
		await postForm("/api/tracks/import", formData);
		importForm.reset();
		await refreshMapData();
		updateDrawerMessage("GPX import complete. The track is now on the map.");
	});

	collectionForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		await postJson("/api/collections", {
			name: collectionNameInput.value.trim(),
			kind: collectionKindSelect.value,
			starts_at: null,
			ends_at: null,
		});
		collectionForm.reset();
		collectionKindSelect.value = "trip";
		await refreshCollections();
	});

	filterObjectType.addEventListener("change", async () => {
		filters.objectType = filterObjectType.value as FiltersState["objectType"];
		await refreshMapData();
	});
	filterTag.addEventListener("change", async () => {
		filters.tag = filterTag.value.trim();
		await refreshMapData();
	});
	filterStartsAfter.addEventListener("change", async () => {
		filters.startsAfter = filterStartsAfter.value;
		await refreshMapData();
	});
	filterEndsBefore.addEventListener("change", async () => {
		filters.endsBefore = filterEndsBefore.value;
		await refreshMapData();
	});

	toggleAddPlaceButton.addEventListener("click", toggleAddPlaceMode);
	collapsedAddPlaceButton.addEventListener("click", toggleAddPlaceMode);

	refreshMapButton.addEventListener("click", async () => {
		await refreshMapData();
	});

	rightPanelSearchInput.addEventListener("input", () => {
		globalSearchResults = null;
		pendingPlace = null;
		clearSelectedMapObject();
		renderViewportObjectList();
	});

	rightPanelSearchForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const query = rightPanelSearchInput.value.trim();
		if (!query) {
			globalSearchResults = null;
			renderViewportObjectList();
			return;
		}
		const params = new URLSearchParams({ query });
		globalSearchResults = await fetchJson<MapObjectsResponse>(
			`/api/search?${params.toString()}`,
		);
		pendingPlace = null;
		clearSelectedMapObject();
		renderGlobalSearchResults();
	});

	toggleSidebarButton.addEventListener("click", () => {
		setWorkspaceSidebarCollapsed(true);
	});

	expandSidebarButton.addEventListener("click", () => {
		setWorkspaceSidebarCollapsed(false);
	});

	openSettingsButton.addEventListener("click", async () => {
		await navigateTo("settings");
	});
	collapsedOpenSettingsButton.addEventListener("click", async () => {
		await navigateTo("settings");
	});

	closeSettingsButton.addEventListener("click", async () => {
		await navigateTo("workspace");
	});

	window.addEventListener("popstate", () => {
		void handlePopState();
	});
}

async function handlePopState(): Promise<void> {
	const view = getViewFromLocation();
	currentView = view;
	applySettingsAreaPrefillFromLocation();
	await renderView(false);
}

async function navigateTo(view: ViewMode): Promise<void> {
	if (view === currentView) {
		return;
	}

	currentView = view;
	window.history.pushState({}, "", buildViewUrl(pathForView(view)));
	await renderView(false);
}

function getViewFromLocation(): ViewMode {
	return window.location.pathname === "/settings" ? "settings" : "workspace";
}

async function renderView(syncHistory: boolean): Promise<void> {
	if (syncHistory) {
		window.history.replaceState({}, "", buildViewUrl(pathForView(currentView)));
	}

	workspaceScreen.classList.toggle("hidden", currentView !== "workspace");
	settingsScreen.classList.toggle("hidden", currentView !== "settings");

	if (currentView === "settings") {
		applySettingsAreaPrefillFromLocation();
		addPlaceMode = false;
		updateModeUi();
		await refreshSettingsData();
		await ensureSettingsMap();
		settingsMap?.resize();
		if (pendingSettingsAreaFit) {
			fitSettingsMapToAreaSelection();
		} else {
			syncSettingsMapToWorkspace();
		}
		updateSelectionSource();
		updateSettingsMapDetail();
	} else {
		clearSettingsRefreshTimer();
		workspaceMap.resize();
		await refreshMapData();
	}
}

function pathForView(view: ViewMode): string {
	return view === "settings" ? "/settings" : "/";
}

function applySettingsAreaPrefillFromLocation(force = false): void {
	if (currentView !== "settings") {
		return;
	}
	applySettingsAreaPrefill(window.location.search, force);
}

function applySettingsAreaPrefill(search: string, force = false): void {
	if (!force && search === lastAppliedSettingsPrefillSearch) {
		return;
	}
	lastAppliedSettingsPrefillSearch = search;
	const prefill = parseSettingsAreaPrefill(search);
	if (!prefill) {
		return;
	}
	applyParsedSettingsAreaPrefill(prefill);
}

function applyParsedSettingsAreaPrefill(prefill: SettingsAreaPrefill): void {
	areaSelection = {
		start: { lng: prefill.bounds.minLon, lat: prefill.bounds.minLat },
		end: { lng: prefill.bounds.maxLon, lat: prefill.bounds.maxLat },
	};
	areaExtractForm = {
		label: prefill.label,
		maxZoom: prefill.maxZoom,
	};
	areaSelectionMode = false;
	pendingSettingsAreaFit = true;
	updateSelectionSource();
	updateSettingsMapDetail();
	syncAreaExtractUi();
}

async function ensureSettingsMap(): Promise<void> {
	if (settingsMap) {
		return;
	}

	const basemap = await fetchJson<BasemapConfig>("/api/basemap");
	settingsMap = new maplibregl.Map({
		container: "settings-map",
		style: basemap.style_url ?? defaultStyle,
		center: workspaceMap.getCenter(),
		zoom: workspaceMap.getZoom(),
	});
	settingsMap.addControl(new maplibregl.NavigationControl(), "top-right");
	settingsMap.on("load", () => {
		ensureSettingsMapLayers();
		updateSelectionSource();
		fitSettingsMapToAreaSelection();
		updateSettingsMapDetail();
	});
	settingsMap.on("click", (event) => {
		if (!areaSelectionMode) {
			return;
		}
		handleAreaSelectionClick(event.lngLat.lng, event.lngLat.lat);
	});
}

function syncSettingsMapToWorkspace(): void {
	if (!settingsMap) {
		return;
	}
	settingsMap.jumpTo({
		center: workspaceMap.getCenter(),
		zoom: workspaceMap.getZoom(),
	});
}

function fitSettingsMapToAreaSelection(): void {
	if (!pendingSettingsAreaFit || !settingsMap) {
		return;
	}
	const bounds = normalizedAreaBounds();
	if (!bounds) {
		pendingSettingsAreaFit = false;
		return;
	}
	settingsMap.fitBounds(
		[
			[bounds.minLon, bounds.minLat],
			[bounds.maxLon, bounds.maxLat],
		],
		{
			padding: 48,
			maxZoom: Number(areaExtractForm.maxZoom || "8"),
		},
	);
	pendingSettingsAreaFit = false;
}

async function refreshCollections(): Promise<void> {
	collections = await fetchJson<CollectionRecord[]>("/api/collections");
	renderCollections();
	await refreshMapData();
}

function renderCollections(): void {
	renderCollectionMultiSelect(filterCollections, {
		collections,
		selectedIds: filters.collectionIds,
		inputName: "filter_collection_ids",
		emptyMessage: "No collections yet.",
		onChange: async (collectionIds) => {
			filters.collectionIds = collectionIds;
			renderImportCollections();
			await refreshMapData();
		},
	});
	renderImportCollections();

	if (!collections.length) {
		collectionList.innerHTML = `<div class="drawer-empty">No collections yet.</div>`;
		return;
	}

	collectionList.innerHTML = collections
		.map(
			(collection) =>
				`<span class="collection-chip">${escapeHtml(collection.name)} · ${escapeHtml(collection.kind)}</span>`,
		)
		.join("");
}

function renderImportCollections(): void {
	renderCollectionMultiSelect(importCollectionList, {
		collections,
		selectedIds: filters.collectionIds,
		inputName: "collection_ids",
		emptyMessage: "Create a collection first if you want to group this track.",
	});
}

async function refreshMapData(): Promise<void> {
	if (!workspaceMap || !workspaceMap.isStyleLoaded()) {
		return;
	}
	if (isObjectEditorOpen()) {
		return;
	}

	const bounds = workspaceMap.getBounds();
	const params = new URLSearchParams({
		min_lat: String(bounds.getSouth()),
		min_lon: String(bounds.getWest()),
		max_lat: String(bounds.getNorth()),
		max_lon: String(bounds.getEast()),
	});

	if (filters.objectType) params.set("object_type", filters.objectType);
	if (filters.collectionIds.length) {
		params.set("collection_ids", filters.collectionIds.join(","));
	}
	if (filters.tag) params.set("tag", filters.tag);
	if (filters.startsAfter)
		params.set("starts_after", new Date(filters.startsAfter).toISOString());
	if (filters.endsBefore)
		params.set("ends_before", new Date(filters.endsBefore).toISOString());

	lastData = await fetchJson<MapObjectsResponse>(
		`/api/map-objects?${params.toString()}`,
	);
	updateWorkspaceOverlaySources();
	await syncDrawerSelection();
}

function isObjectEditorOpen(): boolean {
	return Boolean(
		document.querySelector("#place-edit-form") ??
			document.querySelector("#track-edit-form"),
	);
}

function ensureWorkspaceOverlayLayers(): void {
	if (!workspaceMap.getSource("places")) {
		workspaceMap.addSource("places", {
			type: "geojson",
			data: emptyFeatureCollection(),
		});
	}

	if (!workspaceMap.getSource("tracks")) {
		workspaceMap.addSource("tracks", {
			type: "geojson",
			data: emptyFeatureCollection(),
		});
	}

	if (!workspaceMap.getSource("elevated-track-extrusions")) {
		workspaceMap.addSource("elevated-track-extrusions", {
			type: "geojson",
			data: elevatedTrackExtrusionData,
		});
	}

	if (!workspaceMap.getSource("selected-place")) {
		workspaceMap.addSource("selected-place", {
			type: "geojson",
			data: emptyFeatureCollection(),
		});
	}

	if (!workspaceMap.getSource("selected-track")) {
		workspaceMap.addSource("selected-track", {
			type: "geojson",
			data: emptyFeatureCollection(),
		});
	}

	if (!workspaceMap.getLayer("tracks-line")) {
		workspaceMap.addLayer({
			id: "tracks-line",
			type: "line",
			source: "tracks",
			paint: {
				"line-color": ["get", "display_color"],
				"line-width": 4,
				"line-opacity": 0.9,
			},
		});
		workspaceMap.on("click", "tracks-line", (event) => {
			const feature = event.features?.[0];
			if (!feature) return;
			const trackId = String(feature.properties?.id ?? "");
			const track = findTrackById(trackId);
			if (track) {
				renderTrackDetail(track);
			}
		});
	}

	if (!workspaceMap.getLayer("elevated-track-extrusions")) {
		workspaceMap.addLayer({
			id: "elevated-track-extrusions",
			type: "fill-extrusion",
			source: "elevated-track-extrusions",
			paint: {
				"fill-extrusion-base": 0,
				"fill-extrusion-height": ["get", "height_m"],
				"fill-extrusion-color": [
					"case",
					["boolean", ["get", "selected"], false],
					"#bb5f3a",
					"#d7a18d",
				],
				"fill-extrusion-opacity": 0.78,
				"fill-extrusion-vertical-gradient": true,
			},
		});
	}

	if (!workspaceMap.getLayer("places-circle")) {
		workspaceMap.addLayer({
			id: "places-circle",
			type: "circle",
			source: "places",
			paint: {
				"circle-radius": 7,
				"circle-color": "#2e7764",
				"circle-stroke-width": 2,
				"circle-stroke-color": "#fcfbf8",
			},
		});
		workspaceMap.on("click", "places-circle", (event) => {
			const feature = event.features?.[0];
			if (!feature) return;
			const placeId = String(feature.properties?.id ?? "");
			const place = findPlaceById(placeId);
			if (place) {
				renderPlaceDetail(place);
			}
		});
	}

	if (!workspaceMap.getLayer("selected-track-casing")) {
		workspaceMap.addLayer({
			id: "selected-track-casing",
			type: "line",
			source: "selected-track",
			paint: {
				"line-color": "#fcfbf8",
				"line-width": 11,
				"line-opacity": 0.95,
			},
		});
	}

	if (!workspaceMap.getLayer("selected-track-line")) {
		workspaceMap.addLayer({
			id: "selected-track-line",
			type: "line",
			source: "selected-track",
			paint: {
				"line-color": "#bb5f3a",
				"line-width": 7,
				"line-opacity": 1,
			},
		});
	}

	if (!workspaceMap.getLayer("selected-place-halo")) {
		workspaceMap.addLayer({
			id: "selected-place-halo",
			type: "circle",
			source: "selected-place",
			paint: {
				"circle-radius": 14,
				"circle-color": "#fcfbf8",
				"circle-opacity": 0.96,
			},
		});
	}

	if (!workspaceMap.getLayer("selected-place-circle")) {
		workspaceMap.addLayer({
			id: "selected-place-circle",
			type: "circle",
			source: "selected-place",
			paint: {
				"circle-radius": 9,
				"circle-color": "#bb5f3a",
				"circle-stroke-width": 2,
				"circle-stroke-color": "#fcfbf8",
			},
		});
	}
}

function ensureSettingsMapLayers(): void {
	if (!settingsMap) {
		return;
	}

	if (!settingsMap.getSource("selection-box")) {
		settingsMap.addSource("selection-box", {
			type: "geojson",
			data: emptyFeatureCollection(),
		});
	}

	if (!settingsMap.getLayer("selection-fill")) {
		settingsMap.addLayer({
			id: "selection-fill",
			type: "fill",
			source: "selection-box",
			filter: ["==", "$type", "Polygon"],
			paint: {
				"fill-color": "#2e7764",
				"fill-opacity": 0.12,
			},
		});
	}

	if (!settingsMap.getLayer("selection-outline")) {
		settingsMap.addLayer({
			id: "selection-outline",
			type: "line",
			source: "selection-box",
			filter: ["==", "$type", "Polygon"],
			paint: {
				"line-color": "#2e7764",
				"line-width": 2,
				"line-dasharray": [2, 2],
			},
		});
	}

	if (!settingsMap.getLayer("selection-point")) {
		settingsMap.addLayer({
			id: "selection-point",
			type: "circle",
			source: "selection-box",
			filter: ["==", "$type", "Point"],
			paint: {
				"circle-radius": 6,
				"circle-color": "#2e7764",
				"circle-stroke-width": 2,
				"circle-stroke-color": "#fcfbf8",
			},
		});
	}
}

function updateWorkspaceOverlaySources(): void {
	const trackSource = workspaceMap.getSource("tracks");
	const placeSource = workspaceMap.getSource("places");
	if (trackSource?.type === "geojson") {
		trackSource.setData(
			buildTrackFeatureCollection(
				filterVisibleTracks(lastData.tracks, hiddenTrackIds),
			),
		);
	}
	updateElevatedTrackExtrusions();
	if (placeSource?.type === "geojson") {
		placeSource.setData(buildPlaceFeatureCollection(lastData.places));
	}
	updateWorkspaceSelectionSources();
}

function updateWorkspaceSelectionSources(): void {
	const selectedTrackSource = workspaceMap.getSource("selected-track");
	const selectedPlaceSource = workspaceMap.getSource("selected-place");
	if (selectedTrackSource?.type === "geojson") {
		selectedTrackSource.setData(buildSelectedTrackFeatureCollection());
	}
	if (selectedPlaceSource?.type === "geojson") {
		selectedPlaceSource.setData(buildSelectedPlaceFeatureCollection());
	}
}

function updateElevatedTrackExtrusions(): void {
	elevatedTrackExtrusionData = renderGpxHeight
		? buildElevatedTrackExtrusionFeatureCollection(
				elevatedTracksForMap().map((track) => ({
					id: track.id,
					geometry: parseTrackGeometry(track),
					selected:
						selectedMapObject?.objectType === "track" &&
						selectedMapObject.id === track.id,
				})),
			)
		: buildElevatedTrackExtrusionFeatureCollection([]);
	const source = workspaceMap.getSource("elevated-track-extrusions");
	if (source?.type === "geojson") {
		source.setData(elevatedTrackExtrusionData);
	}
}

function elevatedTracksForMap(): TrackRecord[] {
	const tracks = filterVisibleTracks(lastData.tracks, hiddenTrackIds);
	if (selectedMapObject?.objectType !== "track") {
		return tracks;
	}
	if (hiddenTrackIds.has(selectedMapObject.id)) {
		return tracks;
	}
	const selectedTrack = findTrackById(selectedMapObject.id);
	if (!selectedTrack || tracks.some((track) => track.id === selectedTrack.id)) {
		return tracks;
	}
	return [...tracks, selectedTrack];
}

function renderDrawerEmpty(): void {
	clearSelectedMapObject();
	renderViewportObjectList();
}

function updateDrawerMessage(message: string): void {
	detailPanel.innerHTML = `<div class="drawer-empty">${escapeHtml(message)}</div>`;
}

function renderTrackDetail(track: TrackRecord): void {
	const geometry = parseTrackGeometry(track);
	const elevationRange = trackElevationRange(geometry);
	const elevationProfile = trackElevationProfile(geometry);
	selectMapObject({
		id: track.id,
		objectType: "track",
	});
	detailPanel.innerHTML = `
    <div class="drawer-card">
      <h2>${escapeHtml(track.title ?? "Untitled track")}</h2>
      <div class="inline-actions">
        <button id="edit-track" class="secondary" type="button">Edit</button>
        <button id="copy-object-link" class="secondary" type="button">Copy link</button>
        <button id="toggle-track-visibility" class="secondary" type="button">${
					hiddenTrackIds.has(track.id) ? "Show on map" : "Hide from map"
				}</button>
      </div>
      <div class="meta-row">
        <span class="meta-pill">Track</span>
        ${track.distance_m ? `<span class="meta-pill">${Math.round(track.distance_m)} m</span>` : ""}
        ${track.start_time ? `<span class="meta-pill">${escapeHtml(new Date(track.start_time).toLocaleString())}</span>` : ""}
      </div>
      ${track.notes ? `<div>${escapeHtml(track.notes)}</div>` : ""}
      <div class="detail-list">
        ${track.original_filename ? `<div><strong>Original file</strong><br />${escapeHtml(track.original_filename)}</div>` : ""}
        ${renderTrackGpxMetadata(track.gpx_metadata)}
        ${elevationRange ? `<div><strong>Elevation</strong><br />${escapeHtml(formatElevationRange(elevationRange))}</div>` : ""}
        <div><strong>Bounds</strong><br />${track.min_lat.toFixed(4)}, ${track.min_lon.toFixed(4)} → ${track.max_lat.toFixed(4)}, ${track.max_lon.toFixed(4)}</div>
      </div>
      ${elevationProfile ? renderElevationReliefMap(elevationProfile, track) : ""}
    </div>
  `;

	must<HTMLButtonElement>("#edit-track").addEventListener("click", () => {
		openTrackEditor(track);
	});
	must<HTMLButtonElement>("#copy-object-link").addEventListener("click", (event) => {
		void copySelectedObjectLink(event.currentTarget);
	});
	must<HTMLButtonElement>("#toggle-track-visibility").addEventListener(
		"click",
		() => {
			if (hiddenTrackIds.has(track.id)) {
				hiddenTrackIds.delete(track.id);
			} else {
				hiddenTrackIds.add(track.id);
			}
			updateWorkspaceOverlaySources();
			renderTrackDetail(track);
		},
	);
}

function renderTrackGpxMetadata(metadata: TrackGpxMetadata | null): string {
	if (!metadata) {
		return "";
	}

	const fields: Array<[string, string | number | null]> = [
		["GPX name", metadata.file_name],
		["GPX description", metadata.file_description],
		["Creator", metadata.creator],
		[
			"GPX timestamp",
			metadata.file_time ? new Date(metadata.file_time).toLocaleString() : null,
		],
		["Keywords", metadata.keywords],
		["Author", metadata.author],
		["Comment", metadata.comment],
		["Source", metadata.source],
		["Track type", metadata.track_type],
		["Track number", metadata.number],
	];
	const renderedFields = fields
		.filter(([, value]) => value !== null && value !== "")
		.map(
			([label, value]) =>
				`<div><strong>${escapeHtml(label)}</strong><br />${escapeHtml(String(value))}</div>`,
		)
		.join("");
	const renderedLinks = metadata.links
		.map(
			(link) =>
				`<li><a href="${escapeHtml(link.href)}" target="_blank" rel="noreferrer">${escapeHtml(link.text ?? link.href)}</a>${link.media_type ? ` (${escapeHtml(link.media_type)})` : ""}</li>`,
		)
		.join("");

	return `${renderedFields}${renderedLinks ? `<div><strong>GPX links</strong><ul>${renderedLinks}</ul></div>` : ""}`;
}

function renderElevationReliefMap(
	profile: ElevationProfile,
	track: TrackRecord,
): string {
	const width = 320;
	const height = 118;
	const left = 10;
	const right = 10;
	const top = 12;
	const bottom = 28;
	const plotWidth = width - left - right;
	const plotHeight = height - top - bottom;
	const baselineY = top + plotHeight;
	const min = profile.range.min;
	const max = profile.range.max;
	const span = max - min;
	const pointFor = (point: { progress: number; elevationMeters: number }) => {
		const x = left + point.progress * plotWidth;
		const normalized = span === 0 ? 0.5 : (point.elevationMeters - min) / span;
		const y = top + (1 - normalized) * plotHeight;
		return { x, y };
	};
	const linePaths = profile.segments
		.map((segment) =>
			segment.points
				.map((point, index) => {
					const { x, y } = pointFor(point);
					return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
				})
				.join(" "),
		)
		.join(" ");
	const areaPaths = profile.segments
		.map((segment) => {
			const points = segment.points.map(pointFor);
			const first = points[0];
			const last = points.at(-1);
			if (!first || !last) {
				return "";
			}
			return [
				`M ${first.x.toFixed(2)} ${baselineY.toFixed(2)}`,
				...points.map(({ x, y }) => `L ${x.toFixed(2)} ${y.toFixed(2)}`),
				`L ${last.x.toFixed(2)} ${baselineY.toFixed(2)}`,
				"Z",
			].join(" ");
		})
		.filter(Boolean)
		.join(" ");
	const startLabel = track.start_time ? formatCompactTimestamp(track.start_time) : "Start";
	const endLabel = track.end_time ? formatCompactTimestamp(track.end_time) : "End";

	return `
    <div class="elevation-relief" aria-label="Elevation profile">
      <div class="elevation-relief-header">
        <strong>Elevation profile</strong>
        <span>${escapeHtml(formatElevationRange(profile.range))}</span>
      </div>
      <svg class="elevation-relief-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="Elevation change over time" preserveAspectRatio="none">
        <path class="elevation-relief-grid" d="M ${left} ${top} H ${width - right} M ${left} ${baselineY} H ${width - right}" />
        <path class="elevation-relief-area" d="${areaPaths}" />
        <path class="elevation-relief-line" d="${linePaths}" />
        <text class="elevation-relief-label elevation-relief-label-high" x="${left}" y="${top + 5}">${escapeHtml(`${Math.round(max)} m`)}</text>
        <text class="elevation-relief-label elevation-relief-label-low" x="${left}" y="${baselineY - 4}">${escapeHtml(`${Math.round(min)} m`)}</text>
        <text class="elevation-relief-time" x="${left}" y="${height - 7}">${escapeHtml(startLabel)}</text>
        <text class="elevation-relief-time elevation-relief-time-end" x="${width - right}" y="${height - 7}">${escapeHtml(endLabel)}</text>
      </svg>
    </div>
  `;
}

function renderPlaceDetail(place: PlaceRecord): void {
	selectMapObject({
		id: place.id,
		objectType: "place",
	});
	detailPanel.innerHTML = `
    <div class="drawer-card">
      <h2>${escapeHtml(place.name)}</h2>
      <div class="inline-actions">
        <button id="edit-place" class="secondary" type="button">Edit</button>
        <button id="copy-object-link" class="secondary" type="button">Copy link</button>
      </div>
      <div class="meta-row">
        <span class="meta-pill">Place</span>
        ${place.category ? `<span class="meta-pill">${escapeHtml(place.category)}</span>` : ""}
        ${place.visit_start ? `<span class="meta-pill">${escapeHtml(new Date(place.visit_start).toLocaleString())}</span>` : ""}
      </div>
      ${place.notes ? `<div>${escapeHtml(place.notes)}</div>` : ""}
      <div class="detail-list">
        <div><strong>Coordinates</strong><br />${place.latitude.toFixed(6)}, ${place.longitude.toFixed(6)}</div>
      </div>
    </div>
  `;

	must<HTMLButtonElement>("#edit-place").addEventListener("click", () => {
		openPlaceEditor(place);
	});
	must<HTMLButtonElement>("#copy-object-link").addEventListener("click", (event) => {
		void copySelectedObjectLink(event.currentTarget);
	});
}

function renderViewportObjectList(): void {
	const filtered = filterViewportObjects(
		rightPanelSearchInput.value,
		lastData.tracks,
		lastData.places,
	);
	const emptyMessage = rightPanelSearchInput.value.trim()
		? "No in-view places or tracks match this search."
		: "No places or tracks are currently in view.";
	renderObjectList("In View", filtered, emptyMessage, false);
}

function renderGlobalSearchResults(): void {
	renderObjectList(
		"Search Results",
		globalSearchResults ?? { places: [], tracks: [] },
		"No global places or tracks match this search.",
		true,
	);
}

function renderObjectList(
	heading: string,
	data: MapObjectsResponse,
	emptyMessage: string,
	focusOnSelect: boolean,
): void {
	const center = workspaceMap.getCenter();
	const items = sortViewportObjectsByDistance(
		{
			latitude: center.lat,
			longitude: center.lng,
		},
		data.tracks,
		data.places,
	);

	if (items.length === 0) {
		detailPanel.innerHTML = `
      <div class="drawer-empty">
        ${escapeHtml(emptyMessage)}
      </div>
    `;
		return;
	}

	detailPanel.innerHTML = `
    <div class="drawer-card">
      <h2>${escapeHtml(heading)}</h2>
      <div class="viewport-object-list">
		${items
					.map(
						(item) => {
							const isHiddenTrack =
								item.objectType === "track" && hiddenTrackIds.has(item.id);
							return `
              <button
                class="viewport-object-row secondary${isHiddenTrack ? " viewport-object-row-hidden" : ""}"
                type="button"
                data-object-id="${item.id}"
                data-object-type="${item.objectType}"
              >
                <span class="viewport-object-copy">
                  <strong class="${isHiddenTrack ? "viewport-object-title-hidden" : ""}">${escapeHtml(item.title)}</strong>
                  <span>${item.objectType === "track" ? "Track" : "Place"}</span>
                </span>
                <span class="viewport-object-distance">${escapeHtml(formatDistance(item.distanceMeters))}</span>
              </button>
            `;
						},
					)
					.join("")}
      </div>
    </div>
  `;

	for (const button of detailPanel.querySelectorAll<HTMLButtonElement>(
		"[data-object-id][data-object-type]",
	)) {
		button.addEventListener("click", () => {
			const objectId = button.dataset.objectId ?? "";
			const objectType = button.dataset.objectType;
			if (objectType === "track") {
				const track = data.tracks.find((item) => item.id === objectId);
				if (track) {
					renderTrackDetail(track);
					if (focusOnSelect) {
						focusTrackOnMap(track);
					}
				}
				return;
			}
			if (objectType === "place") {
				const place = data.places.find((item) => item.id === objectId);
				if (place) {
					renderPlaceDetail(place);
					if (focusOnSelect) {
						focusPlaceOnMap(place);
					}
				}
			}
		});
	}
}

async function syncDrawerSelection(): Promise<void> {
	if (pendingPlace) {
		return;
	}
	if (!selectedMapObject) {
		renderViewportObjectList();
		return;
	}
	if (selectedMapObject.objectType === "track") {
		const track = findTrackById(selectedMapObject.id);
		if (track) {
			renderTrackDetail(track);
			return;
		}
	}
	if (selectedMapObject.objectType === "place") {
		const place = findPlaceById(selectedMapObject.id);
		if (place) {
			renderPlaceDetail(place);
			return;
		}
	}

	if (await renderSelectedMapObjectById(selectedMapObject)) {
		return;
	}

	clearSelectedMapObject();
	renderViewportObjectList();
}

async function renderSelectedMapObjectById(
	object: SelectedMapObjectState,
): Promise<boolean> {
	const selectedObject = await fetchSelectedMapObject(object);
	if (selectedObject?.objectType === "track") {
		upsertResolvedTrack(selectedObject.track);
		renderTrackDetail(selectedObject.track);
		return true;
	}
	if (selectedObject?.objectType === "place") {
		upsertResolvedPlace(selectedObject.place);
		renderPlaceDetail(selectedObject.place);
		return true;
	}

	return false;
}

async function fetchSelectedMapObject(
	object: SelectedMapObjectState,
): Promise<
	| { objectType: "track"; track: TrackRecord }
	| { objectType: "place"; place: PlaceRecord }
	| null
> {
	try {
		if (object.objectType === "track") {
			return {
				objectType: "track",
				track: await fetchJson<TrackRecord>(`/api/tracks/${object.id}`),
			};
		}
		return {
			objectType: "place",
			place: await fetchJson<PlaceRecord>(`/api/places/${object.id}`),
		};
	} catch {
		return null;
	}
}

function upsertResolvedTrack(track: TrackRecord): void {
	if (!globalSearchResults) {
		globalSearchResults = { tracks: [], places: [] };
	}
	globalSearchResults.tracks = [
		track,
		...globalSearchResults.tracks.filter((item) => item.id !== track.id),
	];
}

function removeResolvedTrack(trackId: string): void {
	lastData = {
		...lastData,
		tracks: lastData.tracks.filter((item) => item.id !== trackId),
	};
	if (globalSearchResults) {
		globalSearchResults = {
			...globalSearchResults,
			tracks: globalSearchResults.tracks.filter((item) => item.id !== trackId),
		};
	}
}

function upsertResolvedPlace(place: PlaceRecord): void {
	if (!globalSearchResults) {
		globalSearchResults = { tracks: [], places: [] };
	}
	globalSearchResults.places = [
		place,
		...globalSearchResults.places.filter((item) => item.id !== place.id),
	];
}

function removeResolvedPlace(placeId: string): void {
	lastData = {
		...lastData,
		places: lastData.places.filter((item) => item.id !== placeId),
	};
	if (globalSearchResults) {
		globalSearchResults = {
			...globalSearchResults,
			places: globalSearchResults.places.filter((item) => item.id !== placeId),
		};
	}
}

function openPlaceDrawer(place: PendingPlaceState): void {
	pendingPlace = place;
	clearSelectedMapObject();
	addPlaceMode = true;
	updateModeUi();
	detailPanel.innerHTML = `
    <form id="place-form" class="drawer-card">
      <h2>New place</h2>
      <div class="meta-row">
        <span class="meta-pill">${place.latitude.toFixed(6)}, ${place.longitude.toFixed(6)}</span>
      </div>
      <div class="field-grid">
        <label>
          Name
          <input name="name" type="text" required />
        </label>
        <label>
          Category
          <input name="category" type="text" placeholder="lookout" />
        </label>
        <label>
          Notes
          <textarea name="notes" placeholder="What matters about this place?"></textarea>
        </label>
        <div class="field-grid two-up">
          <label>
            Stay start
            <input name="visit_start" type="datetime-local" />
          </label>
          <label>
            Stay end
            <input name="visit_end" type="datetime-local" />
          </label>
        </div>
        <label>
          Tags
          <input name="tags" type="text" placeholder="future, walk" />
        </label>
        <div>
          <strong>Collections</strong>
          <div id="place-collection-selector"></div>
        </div>
      </div>
      <div class="inline-actions">
        <button type="submit">Save place</button>
        <button id="cancel-place" class="secondary" type="button">Cancel</button>
      </div>
    </form>
  `;

	const placeForm = must<HTMLFormElement>("#place-form");
	renderCollectionMultiSelect(must("#place-collection-selector"), {
		collections,
		selectedIds: [],
		inputName: "collection_ids",
		emptyMessage: "Create a collection first if you want to group this place.",
	});
	const cancelButton = must<HTMLButtonElement>("#cancel-place");

	placeForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const formData = new FormData(placeForm);
		await postJson("/api/places", {
			name: String(formData.get("name") ?? "").trim(),
			category: optionalString(formData.get("category")),
			notes: optionalString(formData.get("notes")),
			latitude: place.latitude,
			longitude: place.longitude,
			visit_start: toIsoOrNull(formData.get("visit_start")),
			visit_end: toIsoOrNull(formData.get("visit_end")),
			collection_ids: formData.getAll("collection_ids"),
			tag_names: splitCsv(optionalString(formData.get("tags"))),
		});
		addPlaceMode = false;
		pendingPlace = null;
		updateModeUi();
		await refreshMapData();
		renderDrawerEmpty();
	});

	cancelButton.addEventListener("click", () => {
		pendingPlace = null;
		addPlaceMode = false;
		updateModeUi();
		renderDrawerEmpty();
	});
}

function openTrackEditor(track: TrackRecord, confirmDelete = false): void {
	selectMapObject({
		id: track.id,
		objectType: "track",
	});
	detailPanel.innerHTML = `
    <form id="track-edit-form" class="drawer-card">
      <h2>Edit track</h2>
      <div class="field-grid">
        <label>
          Title
          <input name="title" type="text" value="${escapeHtml(track.title ?? "")}" />
        </label>
        <label>
          Notes
          <textarea name="notes">${escapeHtml(track.notes ?? "")}</textarea>
        </label>
        <div>
          <strong>Collections</strong>
          <div id="track-collection-selector"></div>
        </div>
      </div>
      <div class="inline-actions">
        <button type="submit">Save</button>
        <button id="cancel-track-edit" class="secondary" type="button">Cancel</button>
        <button id="delete-track" class="secondary danger" type="button">Delete</button>
      </div>
      ${
				confirmDelete
					? `<div class="status warn">
          Delete this track from the database?
          <div class="inline-actions section-space">
            <button id="confirm-track-delete" class="danger" type="button">Confirm</button>
            <button id="keep-track" class="secondary" type="button">Keep track</button>
          </div>
        </div>`
					: ""
			}
    </form>
  `;

	const form = must<HTMLFormElement>("#track-edit-form");
	renderCollectionMultiSelect(must("#track-collection-selector"), {
		collections,
		selectedIds: track.collection_ids,
		inputName: "collection_ids",
		emptyMessage: "Create a collection first if you want to group this track.",
	});
	const cancelButton = must<HTMLButtonElement>("#cancel-track-edit");
	const deleteButton = must<HTMLButtonElement>("#delete-track");

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const formData = new FormData(form);
		const updated = await patchJson<TrackRecord>(`/api/tracks/${track.id}`, {
			title: optionalString(formData.get("title")),
			notes: optionalString(formData.get("notes")),
			collection_ids: formData.getAll("collection_ids"),
		});
		await refreshMapData();
		renderTrackDetail(updated);
	});

	cancelButton.addEventListener("click", () => {
		renderTrackDetail(track);
	});

	deleteButton.addEventListener("click", () => {
		openTrackEditor(track, true);
	});

	if (confirmDelete) {
		must<HTMLButtonElement>("#keep-track").addEventListener("click", () => {
			openTrackEditor(track, false);
		});
		must<HTMLButtonElement>("#confirm-track-delete").addEventListener(
			"click",
			async () => {
				await deleteJson(`/api/tracks/${track.id}`);
				hiddenTrackIds.delete(track.id);
				removeResolvedTrack(track.id);
				clearSelectedMapObject();
				updateWorkspaceOverlaySources();
				renderViewportObjectList();
				await refreshMapData();
			},
		);
	}
}

function openPlaceEditor(place: PlaceRecord, confirmDelete = false): void {
	selectMapObject({
		id: place.id,
		objectType: "place",
	});
	detailPanel.innerHTML = `
    <form id="place-edit-form" class="drawer-card">
      <h2>Edit place</h2>
      <div class="field-grid">
        <label>
          Name
          <input name="name" type="text" required value="${escapeHtml(place.name)}" />
        </label>
        <label>
          Category
          <input name="category" type="text" value="${escapeHtml(place.category ?? "")}" />
        </label>
        <label>
          Notes
          <textarea name="notes">${escapeHtml(place.notes ?? "")}</textarea>
        </label>
        <div class="field-grid two-up">
          <label>
            Stay start
            <input name="visit_start" type="datetime-local" value="${formatDateTimeLocalValue(place.visit_start)}" />
          </label>
          <label>
            Stay end
            <input name="visit_end" type="datetime-local" value="${formatDateTimeLocalValue(place.visit_end)}" />
          </label>
        </div>
      </div>
      <div class="inline-actions">
        <button type="submit">Save</button>
        <button id="cancel-place-edit" class="secondary" type="button">Cancel</button>
        <button id="delete-place" class="secondary danger" type="button">Delete</button>
      </div>
      ${
				confirmDelete
					? `<div class="status warn">
          Delete this place from the database?
          <div class="inline-actions section-space">
            <button id="confirm-place-delete" class="danger" type="button">Confirm</button>
            <button id="keep-place" class="secondary" type="button">Keep place</button>
          </div>
        </div>`
					: ""
			}
    </form>
  `;

	const form = must<HTMLFormElement>("#place-edit-form");
	const cancelButton = must<HTMLButtonElement>("#cancel-place-edit");
	const deleteButton = must<HTMLButtonElement>("#delete-place");

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const formData = new FormData(form);
		const updated = await patchJson<PlaceRecord>(`/api/places/${place.id}`, {
			name: String(formData.get("name") ?? "").trim(),
			category: optionalString(formData.get("category")),
			notes: optionalString(formData.get("notes")),
			visit_start: toIsoOrNull(formData.get("visit_start")),
			visit_end: toIsoOrNull(formData.get("visit_end")),
		});
		await refreshMapData();
		renderPlaceDetail(updated);
	});

	cancelButton.addEventListener("click", () => {
		renderPlaceDetail(place);
	});

	deleteButton.addEventListener("click", () => {
		openPlaceEditor(place, true);
	});

	if (confirmDelete) {
		must<HTMLButtonElement>("#keep-place").addEventListener("click", () => {
			openPlaceEditor(place, false);
		});
		must<HTMLButtonElement>("#confirm-place-delete").addEventListener(
			"click",
			async () => {
				await deleteJson(`/api/places/${place.id}`);
				removeResolvedPlace(place.id);
				clearSelectedMapObject();
				updateWorkspaceOverlaySources();
				renderViewportObjectList();
				await refreshMapData();
			},
		);
	}
}

async function refreshSettingsData(showBusy = true): Promise<void> {
	if (showBusy) {
		settingsState.isBusy = true;
		renderSettings();
	}
	const [builds, local, jobs] = await Promise.all([
		fetchJson<MapsBuildsResponse>("/api/settings/maps/builds"),
		fetchJson<MapsLocalResponse>("/api/settings/maps/local"),
		fetchJson<MapsJobsResponse>("/api/settings/maps/jobs"),
	]);
	settingsState.builds = builds.builds;
	settingsState.chunks = local.chunks;
	settingsState.jobs = jobs.jobs.slice(0, 8);
	settingsState.selectedBuildKey =
		local.selected_build_key ??
		builds.selected_build_key ??
		builds.builds[0]?.key ??
		"";
	if (showBusy) {
		settingsState.isBusy = false;
	}
	renderSettings();
	scheduleSettingsRefresh();
}

function clearSettingsRefreshTimer(): void {
	if (settingsRefreshTimer !== null) {
		window.clearTimeout(settingsRefreshTimer);
		settingsRefreshTimer = null;
	}
}

function hasActiveMapJobs(): boolean {
	return settingsState.jobs.some((job) => isJobActive(job));
}

function scheduleSettingsRefresh(): void {
	clearSettingsRefreshTimer();
	if (currentView !== "settings" || !hasActiveMapJobs()) {
		return;
	}
	settingsRefreshTimer = window.setTimeout(() => {
		void refreshSettingsData(false).catch((error: unknown) => {
			console.error("Could not refresh map settings", error);
		});
	}, 1000);
}

function renderSettings(): void {
	const staleCount = settingsState.chunks.filter((chunk) => chunk.stale).length;
	const activeJobCount = settingsState.jobs.filter((job) =>
		isJobActive(job),
	).length;
	const readyChunkCount = settingsState.chunks.filter(
		(chunk) => chunk.selected_build_ready,
	).length;
	settingsContent.innerHTML = `
    <section class="settings-section">
      <div class="settings-row">
        <label>
          Build
          <select id="settings-build">
            ${settingsState.builds
							.map(
								(build) => `
                  <option value="${build.key}" ${build.key === settingsState.selectedBuildKey ? "selected" : ""}>
                    ${escapeHtml(build.key)}${build.version ? ` · ${escapeHtml(build.version)}` : ""}
                  </option>`,
							)
							.join("")}
          </select>
        </label>
        <button id="refresh-builds" class="secondary" type="button">Refresh list</button>
      </div>
      <div class="inline-actions">
        <button id="world-to-6" type="button" ${settingsState.isBusy || !settingsState.selectedBuildKey ? "disabled" : ""}>World to 6</button>
        <button id="rebuild-stale" class="secondary" type="button" ${settingsState.isBusy || staleCount === 0 ? "disabled" : ""}>Rebuild stale</button>
      </div>
      <label class="toggle">
        <input id="render-gpx-height" type="checkbox" ${renderGpxHeight ? "checked" : ""} />
        Render GPX height
      </label>
      ${
				settingsState.isBusy || staleCount
					? `<div class="status ${staleCount ? "warn" : ""}">
              ${
								settingsState.isBusy
									? "Working…"
									: `${staleCount} chunks are stale for ${escapeHtml(settingsState.selectedBuildKey || "the selected build")}.`
							}
            </div>`
					: ""
			}
      <div class="settings-stats">
        <div class="stat-card">
          <strong>${activeJobCount}</strong>
          <span>Active jobs</span>
        </div>
        <div class="stat-card">
          <strong>${readyChunkCount}</strong>
          <span>Ready chunks</span>
        </div>
        <div class="stat-card">
          <strong>${staleCount}</strong>
          <span>Stale chunks</span>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <div class="section-heading">Area Extract</div>
      <div class="field-grid">
        <label>
          Label
          <input id="area-label" type="text" placeholder="Brisbane detail" value="${escapeHtml(areaExtractForm.label)}" />
        </label>
        <label>
          Max zoom
          <input id="area-max-zoom" type="number" min="0" max="12" value="${escapeHtml(areaExtractForm.maxZoom)}" />
        </label>
        <div class="inline-actions">
          <button id="select-area" class="secondary" type="button">${areaSelectionMode ? "Area mode on" : "Select area"}</button>
          <button id="clear-area" class="secondary" type="button" ${!areaSelection.start ? "disabled" : ""}>Clear</button>
          <button id="create-area-extract" type="button" ${!hasCompleteAreaSelection() || !settingsState.selectedBuildKey ? "disabled" : ""}>Create extract</button>
        </div>
        <div id="area-selection-status" class="status">
          ${describeAreaSelection()}
        </div>
      </div>
    </section>

    <section class="settings-section">
      <div class="section-heading">Active Layers</div>
      <form id="active-layers-form" class="field-grid">
        ${
					settingsState.chunks.length
						? settingsState.chunks
								.map((chunk) =>
									renderChunkEditor(chunk, settingsState.selectedBuildKey),
								)
								.join("")
						: `<div class="drawer-empty">No managed PMTiles chunks yet.</div>`
				}
        <button type="submit" ${settingsState.isBusy || !settingsState.selectedBuildKey ? "disabled" : ""}>Save active stack</button>
      </form>
    </section>

    <section class="settings-section">
      <div class="section-heading">Jobs</div>
      <div class="field-grid">
        ${
					settingsState.jobs.length
						? settingsState.jobs.map((job) => renderJobRow(job)).join("")
						: `<div class="drawer-empty">No map jobs yet.</div>`
				}
      </div>
    </section>
  `;

	wireSettingsPanel();
}

function wireSettingsPanel(): void {
	const buildSelect =
		settingsContent.querySelector<HTMLSelectElement>("#settings-build");
	const refreshBuildsButton =
		settingsContent.querySelector<HTMLButtonElement>("#refresh-builds");
	const worldTo6Button =
		settingsContent.querySelector<HTMLButtonElement>("#world-to-6");
	const rebuildStaleButton =
		settingsContent.querySelector<HTMLButtonElement>("#rebuild-stale");
	const renderGpxHeightInput =
		settingsContent.querySelector<HTMLInputElement>("#render-gpx-height");
	const selectAreaButton =
		settingsContent.querySelector<HTMLButtonElement>("#select-area");
	const clearAreaButton =
		settingsContent.querySelector<HTMLButtonElement>("#clear-area");
	const createAreaExtractButton =
		settingsContent.querySelector<HTMLButtonElement>("#create-area-extract");
	const areaLabelInput =
		settingsContent.querySelector<HTMLInputElement>("#area-label");
	const areaMaxZoomInput =
		settingsContent.querySelector<HTMLInputElement>("#area-max-zoom");
	const activeLayersForm = settingsContent.querySelector<HTMLFormElement>(
		"#active-layers-form",
	);
	const cancelJobButtons = Array.from(
		settingsContent.querySelectorAll<HTMLButtonElement>("[data-cancel-job-id]"),
	);
	const retryJobButtons = Array.from(
		settingsContent.querySelectorAll<HTMLButtonElement>("[data-retry-job-id]"),
	);
	const removeJobButtons = Array.from(
		settingsContent.querySelectorAll<HTMLButtonElement>("[data-remove-job-id]"),
	);

	buildSelect?.addEventListener("change", () => {
		settingsState.selectedBuildKey = buildSelect.value;
		renderSettings();
	});

	refreshBuildsButton?.addEventListener("click", async () => {
		await refreshSettingsData();
	});

	areaLabelInput?.addEventListener("input", () => {
		areaExtractForm.label = areaLabelInput.value;
	});

	areaMaxZoomInput?.addEventListener("input", () => {
		areaExtractForm.maxZoom = areaMaxZoomInput.value;
	});

	worldTo6Button?.addEventListener("click", async () => {
		if (!settingsState.selectedBuildKey) return;
		await runManagedMapsAction(async () => {
			await postJson("/api/settings/maps/world-to-6", {
				build_key: settingsState.selectedBuildKey,
			});
			await waitForMapJobs();
		});
	});

	rebuildStaleButton?.addEventListener("click", async () => {
		if (!settingsState.selectedBuildKey) return;
		await runManagedMapsAction(async () => {
			await postJson("/api/settings/maps/rebuild-chunks", {
				build_key: settingsState.selectedBuildKey,
			});
			await waitForMapJobs();
		});
	});

	renderGpxHeightInput?.addEventListener("change", () => {
		renderGpxHeight = renderGpxHeightInput.checked;
		writeRenderGpxHeight(renderGpxHeight);
		updateElevatedTrackExtrusions();
	});

	selectAreaButton?.addEventListener("click", () => {
		areaSelectionMode = !areaSelectionMode;
		updateSettingsMapDetail();
		syncAreaExtractUi();
	});

	clearAreaButton?.addEventListener("click", () => {
		areaSelectionMode = false;
		clearAreaSelection();
		updateSettingsMapDetail();
		syncAreaExtractUi();
	});

	createAreaExtractButton?.addEventListener("click", async () => {
		if (!settingsState.selectedBuildKey || !hasCompleteAreaSelection()) return;
		const bounds = normalizedAreaBounds();
		if (!bounds) return;

		await runManagedMapsAction(async () => {
			await postJson("/api/settings/maps/area-extract", {
				build_key: settingsState.selectedBuildKey,
				label: areaExtractForm.label.trim() || "Regional detail",
				min_lon: bounds.minLon,
				min_lat: bounds.minLat,
				max_lon: bounds.maxLon,
				max_lat: bounds.maxLat,
				max_zoom: Number(areaExtractForm.maxZoom || "8"),
			});
			await waitForMapJobs();
			areaSelectionMode = false;
			clearAreaSelection();
			updateSettingsMapDetail();
		});
	});

	activeLayersForm?.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!settingsState.selectedBuildKey) return;
		const rows = Array.from(
			settingsContent.querySelectorAll<HTMLElement>("[data-chunk-id]"),
		);
		const layers = rows.map((row) => {
			const chunkId = row.dataset.chunkId ?? "";
			const enabled =
				row.querySelector<HTMLInputElement>("input[name='enabled']")?.checked ??
				false;
			const displayOrder = Number(
				row.querySelector<HTMLInputElement>("input[name='display_order']")
					?.value || "0",
			);
			return {
				chunk_id: chunkId,
				enabled,
				display_order: displayOrder,
			};
		});

		await runManagedMapsAction(async () => {
			await postJson("/api/settings/maps/active-layers", {
				selected_build_key: settingsState.selectedBuildKey,
				layers,
			});
		});
	});

	for (const button of cancelJobButtons) {
		button.addEventListener("click", async () => {
			const jobId = button.dataset.cancelJobId;
			if (!jobId) return;
			await runManagedMapsAction(async () => {
				await postJson(`/api/settings/maps/jobs/${jobId}/cancel`, {});
				await waitForMapJobs();
			});
		});
	}

	for (const button of retryJobButtons) {
		button.addEventListener("click", async () => {
			const jobId = button.dataset.retryJobId;
			if (!jobId) return;
			await runManagedMapsAction(async () => {
				await postJson(`/api/settings/maps/jobs/${jobId}/retry`, {});
				await waitForMapJobs();
			});
		});
	}

	for (const button of removeJobButtons) {
		button.addEventListener("click", async () => {
			const jobId = button.dataset.removeJobId;
			if (!jobId) return;
			await runManagedMapsAction(async () => {
				await deleteJson(`/api/settings/maps/jobs/${jobId}`);
			});
		});
	}
}

function syncAreaExtractUi(): void {
	const selectAreaButton =
		settingsContent.querySelector<HTMLButtonElement>("#select-area");
	const clearAreaButton =
		settingsContent.querySelector<HTMLButtonElement>("#clear-area");
	const createAreaExtractButton =
		settingsContent.querySelector<HTMLButtonElement>("#create-area-extract");
	const areaSelectionStatus = settingsContent.querySelector<HTMLDivElement>(
		"#area-selection-status",
	);

	if (selectAreaButton) {
		selectAreaButton.textContent = areaSelectionMode
			? "Area mode on"
			: "Select area";
		selectAreaButton.classList.toggle("active", areaSelectionMode);
	}

	if (clearAreaButton) {
		clearAreaButton.disabled = !areaSelection.start;
	}

	if (createAreaExtractButton) {
		createAreaExtractButton.disabled =
			!hasCompleteAreaSelection() || !settingsState.selectedBuildKey;
	}

	if (areaSelectionStatus) {
		areaSelectionStatus.textContent = describeAreaSelection();
	}
}

async function runManagedMapsAction(
	action: () => Promise<void>,
): Promise<void> {
	settingsState.isBusy = true;
	renderSettings();
	try {
		await action();
	} finally {
		settingsState.isBusy = false;
	}
	await refreshSettingsData();
	await refreshBasemapStyle();
}

async function waitForMapJobs(): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		await refreshSettingsData(false);
		if (!hasActiveMapJobs()) {
			return;
		}
		await delay(250);
	}
	throw new Error("Map jobs did not settle in time.");
}

function handleAreaSelectionClick(lng: number, lat: number): void {
	if (!areaSelection.start) {
		areaSelection.start = { lng, lat };
		areaSelection.end = null;
	} else {
		areaSelection.end = { lng, lat };
	}
	updateSelectionSource();
	updateSettingsMapDetail();
	syncAreaExtractUi();
}

function updateSelectionSource(): void {
	if (!settingsMap || !settingsMap.getSource("selection-box")) {
		return;
	}
	const source = settingsMap.getSource("selection-box");
	if (source?.type === "geojson") {
		source.setData(buildSelectionFeatureCollection());
	}
}

function buildSelectionFeatureCollection(): GeoJSON.FeatureCollection {
	if (areaSelection.start && !areaSelection.end) {
		return {
			type: "FeatureCollection",
			features: [
				{
					type: "Feature",
					properties: {},
					geometry: {
						type: "Point",
						coordinates: [areaSelection.start.lng, areaSelection.start.lat],
					},
				},
			],
		};
	}

	const bounds = normalizedAreaBounds();
	if (!bounds) {
		return emptyFeatureCollection();
	}
	return {
		type: "FeatureCollection",
		features: [
			{
				type: "Feature",
				properties: {},
				geometry: {
					type: "Polygon",
					coordinates: [
						[
							[bounds.minLon, bounds.minLat],
							[bounds.minLon, bounds.maxLat],
							[bounds.maxLon, bounds.maxLat],
							[bounds.maxLon, bounds.minLat],
							[bounds.minLon, bounds.minLat],
						],
					],
				},
			},
		],
	};
}

function normalizedAreaBounds(): {
	minLon: number;
	minLat: number;
	maxLon: number;
	maxLat: number;
} | null {
	if (!areaSelection.start || !areaSelection.end) {
		return null;
	}

	return {
		minLon: Math.min(areaSelection.start.lng, areaSelection.end.lng),
		minLat: Math.min(areaSelection.start.lat, areaSelection.end.lat),
		maxLon: Math.max(areaSelection.start.lng, areaSelection.end.lng),
		maxLat: Math.max(areaSelection.start.lat, areaSelection.end.lat),
	};
}

function clearAreaSelection(): void {
	areaSelection = { start: null, end: null };
	updateSelectionSource();
}

function hasCompleteAreaSelection(): boolean {
	return Boolean(areaSelection.start && areaSelection.end);
}

function describeAreaSelection(): string {
	const bounds = normalizedAreaBounds();
	if (!areaSelection.start) {
		return "Enable Select area, then click two corners on the settings map to define a regional PMTiles extract.";
	}
	if (!bounds) {
		return "First corner captured. Click the opposite corner on the settings map.";
	}
	return `${bounds.minLat.toFixed(3)}, ${bounds.minLon.toFixed(3)} → ${bounds.maxLat.toFixed(3)}, ${bounds.maxLon.toFixed(3)}`;
}

function updateSettingsMapDetail(): void {
	settingsMapDetail.textContent = areaSelectionMode
		? areaSelection.start
			? "Click the opposite corner to finish the extract box."
			: "Click a first corner on the map to start the extract box."
		: "Use this map to define regional PMTiles chunks.";
}

function renderJobRow(job: MapsJobRecord): string {
	const chunk = job.chunk_id
		? settingsState.chunks.find((candidate) => candidate.id === job.chunk_id)
		: null;
	const jobLabel = chunk ? chunk.label : job.kind;
	const segmentSummary =
		job.segments_total > 0
			? `${job.segments_done} / ${job.segments_total} segments`
			: "Preparing segments";

	return `
    <div class="job-row">
      <div class="job-row-header">
        <div>
          <strong>${escapeHtml(jobLabel)}</strong>
          <div class="chunk-card-meta">
            <span>${escapeHtml(job.kind)}</span>
            <span>${escapeHtml(job.build_key)}</span>
            <span class="state-pill ${jobStatusClass(job)}">${escapeHtml(jobStatusLabel(job))}</span>
          </div>
        </div>
        <div class="job-row-actions">
          <strong>${job.progress_percent}%</strong>
		  ${
						isJobActive(job)
							? `<button class="secondary" type="button" data-cancel-job-id="${job.id}" ${settingsState.isBusy ? "disabled" : ""}>Cancel</button>`
							: job.status === "failed"
								? `<button class="secondary" type="button" data-retry-job-id="${job.id}" ${settingsState.isBusy ? "disabled" : ""}>Retry</button>
                 <button class="secondary danger" type="button" data-remove-job-id="${job.id}" ${settingsState.isBusy ? "disabled" : ""}>Remove</button>`
								: ""
					}
        </div>
      </div>
      <div class="progress-copy">
        <span>${escapeHtml(job.current_step)}</span>
        <span>${escapeHtml(segmentSummary)}</span>
      </div>
      ${renderProgressBar(job.progress_percent)}
      <div class="chunk-card-meta">
        <span>Updated ${formatTimestamp(job.updated_at)}</span>
        ${
					job.finished_at
						? `<span>Finished ${escapeHtml(formatTimestamp(job.finished_at))}</span>`
						: ""
				}
      </div>
      ${job.error_message ? `<div class="job-error">${escapeHtml(job.error_message)}</div>` : ""}
    </div>
  `;
}

function renderProgressBar(percent: number): string {
	const safePercent = Math.max(0, Math.min(100, percent));
	return `
    <div class="progress-bar" aria-hidden="true">
      <div class="progress-fill" style="width: ${safePercent}%"></div>
    </div>
  `;
}

function jobStatusLabel(job: MapsJobRecord): string {
	if (job.status === "running") {
		return "Running";
	}
	if (job.status === "queued") {
		return "Queued";
	}
	if (job.status === "cancel_requested") {
		return "Cancelling";
	}
	if (job.status === "cancelled") {
		return "Cancelled";
	}
	if (job.status === "failed") {
		return "Failed";
	}
	if (job.status === "completed") {
		return "Completed";
	}
	return job.status;
}

function jobStatusClass(job: MapsJobRecord): string {
	if (job.status === "completed") {
		return "ready";
	}
	if (job.status === "cancelled") {
		return "pending";
	}
	if (job.status === "failed") {
		return "failed";
	}
	if (isJobActive(job)) {
		return "running";
	}
	return "pending";
}

function isJobActive(job: MapsJobRecord): boolean {
	return (
		job.status === "queued" ||
		job.status === "running" ||
		job.status === "cancel_requested"
	);
}

function describeChunkState(chunk: MapsChunkRecord): {
	label: string;
	className: string;
} {
	const latestJob = chunk.latest_job;
	if (latestJob && isJobActive(latestJob)) {
		return {
			label: `${latestJob.current_step} · ${latestJob.progress_percent}%`,
			className: "running",
		};
	}
	if (latestJob?.status === "cancelled") {
		return {
			label: "Cancelled",
			className: "pending",
		};
	}
	if (latestJob?.status === "failed") {
		return {
			label: "Latest build failed",
			className: "failed",
		};
	}
	if (chunk.selected_build_ready) {
		return {
			label: "Ready for selected build",
			className: "ready",
		};
	}
	if (chunk.stale) {
		return {
			label: "Stale for selected build",
			className: "stale",
		};
	}
	return {
		label: "Not downloaded for selected build",
		className: "pending",
	};
}

function formatTimestamp(value: string): string {
	return new Date(value).toLocaleString();
}

function formatCompactTimestamp(value: string): string {
	return new Date(value).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatDistance(distanceMeters: number): string {
	if (distanceMeters < 1000) {
		return `${Math.round(distanceMeters)} m`;
	}
	return `${(distanceMeters / 1000).toFixed(1)} km`;
}

function renderChunkEditor(
	chunk: MapsChunkRecord,
	selectedBuildKey: string,
): string {
	const selectedArchive = chunk.archives.find(
		(archive) => archive.build_key === selectedBuildKey,
	);
	const state = describeChunkState(chunk);
	const archiveSummary = selectedArchive
		? `${selectedArchive.tile_type.toUpperCase()} · z${selectedArchive.min_zoom}-${selectedArchive.max_zoom}`
		: "No materialized archive for this build";
	const archiveCountLabel = `${chunk.archives.length} archive${chunk.archives.length === 1 ? "" : "s"}`;
	const latestJob = chunk.latest_job;
	const progressMarkup = latestJob
		? `
        <div class="field-grid">
          <div class="progress-copy">
            <span>${escapeHtml(latestJob.current_step)}</span>
            <span>${
							latestJob.segments_total > 0
								? `${latestJob.segments_done} / ${latestJob.segments_total} segments`
								: "Waiting for segment scan"
						}</span>
          </div>
          ${renderProgressBar(latestJob.progress_percent)}
        </div>
      `
		: "";
	return `
    <div class="chunk-card" data-chunk-id="${chunk.id}">
      <div class="chunk-card-header">
        <div>
          <strong>${escapeHtml(chunk.label)}</strong>
          <div class="chunk-card-meta">
            <span>${escapeHtml(chunk.kind)}</span>
            <span>${escapeHtml(archiveSummary)}</span>
            <span>${escapeHtml(archiveCountLabel)}</span>
            <span class="state-pill ${state.className}">${escapeHtml(state.label)}</span>
          </div>
        </div>
        <label class="toggle">
          <input name="enabled" type="checkbox" ${chunk.enabled ? "checked" : ""} />
          <span>Active</span>
        </label>
      </div>
      ${progressMarkup}
      <div class="settings-row">
        <label>
          Order
          <input name="display_order" type="number" value="${chunk.display_order}" />
        </label>
        <div class="chunk-card-bounds">
          ${describeChunkBounds(chunk)}
        </div>
      </div>
      ${
				latestJob?.error_message
					? `<div class="job-error">${escapeHtml(latestJob.error_message)}</div>`
					: ""
			}
    </div>
  `;
}

function describeChunkBounds(chunk: MapsChunkRecord): string {
	if (
		chunk.min_lon === null ||
		chunk.min_lat === null ||
		chunk.max_lon === null ||
		chunk.max_lat === null
	) {
		return "Full planet";
	}
	return `${chunk.min_lat.toFixed(2)}, ${chunk.min_lon.toFixed(2)} → ${chunk.max_lat.toFixed(2)}, ${chunk.max_lon.toFixed(2)}`;
}

function updateModeUi(): void {
	toggleAddPlaceButton.classList.toggle("active", addPlaceMode);
	toggleAddPlaceButton.textContent = addPlaceMode
		? "Place mode on"
		: "Add place";
	collapsedAddPlaceButton.classList.toggle("active", addPlaceMode);
}

function findTrackById(trackId: string): TrackRecord | undefined {
	return (
		lastData.tracks.find((track) => track.id === trackId) ??
		globalSearchResults?.tracks.find((track) => track.id === trackId)
	);
}

function findPlaceById(placeId: string): PlaceRecord | undefined {
	return (
		lastData.places.find((place) => place.id === placeId) ??
		globalSearchResults?.places.find((place) => place.id === placeId)
	);
}

function focusTrackOnMap(track: TrackRecord): void {
	workspaceMap.fitBounds(
		[
			[track.min_lon, track.min_lat],
			[track.max_lon, track.max_lat],
		],
		{ padding: 80, maxZoom: 13 },
	);
}

function focusPlaceOnMap(place: PlaceRecord): void {
	workspaceMap.easeTo({
		center: [place.longitude, place.latitude],
		zoom: Math.max(workspaceMap.getZoom(), 12),
	});
}

function buildTrackFeatureCollection(
	tracks: TrackRecord[],
): GeoJSON.FeatureCollection {
	return {
		type: "FeatureCollection",
		features: tracks.map((track) => ({
			type: "Feature",
			properties: {
				id: track.id,
				title: track.title,
				display_color: displayTrackColor(track.id),
			},
			geometry: parseTrackGeometry(track),
		})),
	};
}

function parseTrackGeometry(track: TrackRecord): GeoJSON.Geometry {
	return JSON.parse(track.geometry_json) as GeoJSON.Geometry;
}

function buildSelectedTrackFeatureCollection(): GeoJSON.FeatureCollection {
	if (!selectedMapObject || selectedMapObject.objectType !== "track") {
		return emptyFeatureCollection();
	}
	if (hiddenTrackIds.has(selectedMapObject.id)) {
		return emptyFeatureCollection();
	}
	const track = findTrackById(selectedMapObject.id);
	if (!track) {
		return emptyFeatureCollection();
	}
	return buildTrackFeatureCollection([track]);
}

function buildPlaceFeatureCollection(
	places: PlaceRecord[],
): GeoJSON.FeatureCollection {
	return {
		type: "FeatureCollection",
		features: places.map((place) => ({
			type: "Feature",
			properties: {
				id: place.id,
				name: place.name,
			},
			geometry: {
				type: "Point",
				coordinates: [place.longitude, place.latitude],
			},
		})),
	};
}

function buildSelectedPlaceFeatureCollection(): GeoJSON.FeatureCollection {
	if (!selectedMapObject || selectedMapObject.objectType !== "place") {
		return emptyFeatureCollection();
	}
	const place = findPlaceById(selectedMapObject.id);
	if (!place) {
		return emptyFeatureCollection();
	}
	return buildPlaceFeatureCollection([place]);
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
	return {
		type: "FeatureCollection",
		features: [],
	};
}

async function applyBasemapConfig(): Promise<BasemapConfig> {
	return fetchJson<BasemapConfig>("/api/basemap");
}

async function refreshBasemapStyle(): Promise<void> {
	const basemap = await applyBasemapConfig();
	currentBasemapConfig = basemap;
	await setMapStyle(
		workspaceMap,
		basemap.style_url ?? defaultStyle,
		"workspace",
	);
	if (settingsMap) {
		await setMapStyle(
			settingsMap,
			basemap.style_url ?? defaultStyle,
			"settings",
		);
	}
	scheduleMissingTilesCheck();
}

async function setMapStyle(
	mapInstance: MapGL,
	style: string | StyleSpecification,
	kind: "workspace" | "settings",
): Promise<void> {
	await new Promise<void>((resolve) => {
		mapInstance.once("styledata", () => {
			if (kind === "workspace") {
				ensureWorkspaceOverlayLayers();
				void refreshMapData();
			} else {
				ensureSettingsMapLayers();
				updateSelectionSource();
				updateSettingsMapDetail();
			}
			resolve();
		});
		mapInstance.setStyle(style);
	});
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url);
	if (!response.ok) {
		throw await buildHttpError(response);
	}
	return (await response.json()) as T;
}

async function postJson<T>(url: string, payload: unknown): Promise<T | null> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		throw await buildHttpError(response);
	}

	const text = await response.text();
	if (!text) {
		return null;
	}
	return JSON.parse(text) as T;
}

async function postForm(url: string, payload: FormData): Promise<void> {
	const response = await fetch(url, {
		method: "POST",
		body: payload,
	});
	if (!response.ok) {
		throw await buildHttpError(response);
	}
}

async function patchJson<T>(url: string, payload: unknown): Promise<T> {
	const response = await fetch(url, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		throw await buildHttpError(response);
	}
	return (await response.json()) as T;
}

async function deleteJson(url: string): Promise<void> {
	const response = await fetch(url, {
		method: "DELETE",
	});
	if (!response.ok) {
		throw await buildHttpError(response);
	}
}

async function buildHttpError(response: Response): Promise<Error> {
	let message = `${response.status} ${response.statusText}`;
	try {
		const payload = (await response.json()) as { error?: string };
		if (payload.error) {
			message = payload.error;
		}
	} catch {
		// ignore JSON parse failures and use the HTTP status
	}
	updateDrawerMessage(message);
	return new Error(message);
}

function splitCsv(value: string | null): string[] {
	return (value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

function optionalString(value: FormDataEntryValue | null): string | null {
	const stringValue = typeof value === "string" ? value.trim() : "";
	return stringValue ? stringValue : null;
}

function toIsoOrNull(value: FormDataEntryValue | null): string | null {
	const stringValue = typeof value === "string" ? value : "";
	return stringValue ? new Date(stringValue).toISOString() : null;
}

function formatDateTimeLocalValue(value: string | null): string {
	if (!value) {
		return "";
	}
	const date = new Date(value);
	const localOffsetMs = date.getTimezoneOffset() * 60 * 1000;
	return new Date(date.getTime() - localOffsetMs).toISOString().slice(0, 16);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

function must<T extends Element>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (!element) {
		throw new Error(`Expected element for selector ${selector}`);
	}
	return element;
}
