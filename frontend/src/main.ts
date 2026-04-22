import maplibregl, { LngLatBoundsLike, Map, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

type CollectionKind = "trip" | "future" | "past" | "general";
type ObjectType = "track" | "place";

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
  notes: string | null;
  geometry_json: string;
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
  distance_m: number | null;
  start_time: string | null;
  end_time: string | null;
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
  collectionId: string;
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
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface MapsJobsResponse {
  jobs: MapsJobRecord[];
}

interface SettingsState {
  isOpen: boolean;
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

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App container not found");
}

app.innerHTML = `
  <div class="shell">
    <aside class="panel">
      <div class="panel-scroll">
        <div class="brand">
          <div class="brand-title">
            <h1>Map Travel</h1>
            <span class="pill">v1</span>
          </div>
          <button id="open-settings" class="secondary" type="button">Settings</button>
        </div>

        <section class="section">
          <h2>Tracks</h2>
          <form id="import-form" class="field-grid">
            <label>
              GPX file
              <input id="gpx-file" name="file" type="file" accept=".gpx,application/gpx+xml,text/xml,application/xml" required />
            </label>
            <button type="submit">Import GPX</button>
          </form>
        </section>

        <section class="section">
          <h2>Basemap</h2>
          <div id="basemap-status" class="status">Checking PMTiles…</div>
        </section>

        <section class="section">
          <h2>Filters</h2>
          <div class="field-grid">
            <label>
              Type
              <select id="filter-object-type">
                <option value="">All</option>
                <option value="place">Places</option>
                <option value="track">Tracks</option>
              </select>
            </label>
            <label>
              Collection
              <select id="filter-collection">
                <option value="">All</option>
              </select>
            </label>
            <label>
              Tag
              <input id="filter-tag" type="text" placeholder="future" />
            </label>
            <div class="field-grid two-up">
              <label>
                Starts after
                <input id="filter-starts-after" type="datetime-local" />
              </label>
              <label>
                Ends before
                <input id="filter-ends-before" type="datetime-local" />
              </label>
            </div>
          </div>
        </section>

        <section class="section">
          <h2>Collections</h2>
          <form id="collection-form" class="field-grid">
            <label>
              Name
              <input id="collection-name" type="text" placeholder="South Island Walks" required />
            </label>
            <label>
              Kind
              <select id="collection-kind">
                <option value="trip">Trip</option>
                <option value="future">Future</option>
                <option value="past">Past</option>
                <option value="general">General</option>
              </select>
            </label>
            <button type="submit">Create collection</button>
          </form>
          <div id="collection-list" class="collection-list section-space"></div>
        </section>

        <section class="section">
          <h2>Places</h2>
          <div class="inline-actions">
            <button id="toggle-add-place" class="secondary" type="button">Add place</button>
            <button id="refresh-map" class="secondary" type="button">Refresh</button>
          </div>
        </section>
      </div>
    </aside>

    <main class="panel map-panel">
      <div id="map"></div>
      <div class="map-overlay">
        <div class="overlay-card">
          <strong id="viewport-summary">Loading map…</strong>
          <span id="viewport-detail">Move the map to load places and tracks.</span>
        </div>
        <div class="overlay-card">
          <strong id="mode-indicator">Browse</strong>
          <span id="mode-detail">Select a feature or switch to place mode.</span>
        </div>
      </div>

      <aside id="settings-panel" class="settings-panel hidden">
        <div class="settings-header">
          <div>
            <h2>Settings</h2>
          </div>
          <button id="close-settings" class="secondary" type="button">Close</button>
        </div>
        <div id="settings-content" class="settings-content"></div>
      </aside>
    </main>

    <aside class="panel">
      <div id="detail-panel" class="panel-scroll">
        <div class="drawer-empty">
          Select a track or place on the map, or switch to place mode and click on the map to capture a new point.
        </div>
      </div>
    </aside>
  </div>
`;

const detailPanel = must<HTMLDivElement>("#detail-panel");
const importForm = must<HTMLFormElement>("#import-form");
const gpxFileInput = must<HTMLInputElement>("#gpx-file");
const basemapStatus = must<HTMLDivElement>("#basemap-status");
const collectionForm = must<HTMLFormElement>("#collection-form");
const collectionNameInput = must<HTMLInputElement>("#collection-name");
const collectionKindSelect = must<HTMLSelectElement>("#collection-kind");
const collectionList = must<HTMLDivElement>("#collection-list");
const filterObjectType = must<HTMLSelectElement>("#filter-object-type");
const filterCollection = must<HTMLSelectElement>("#filter-collection");
const filterTag = must<HTMLInputElement>("#filter-tag");
const filterStartsAfter = must<HTMLInputElement>("#filter-starts-after");
const filterEndsBefore = must<HTMLInputElement>("#filter-ends-before");
const toggleAddPlaceButton = must<HTMLButtonElement>("#toggle-add-place");
const refreshMapButton = must<HTMLButtonElement>("#refresh-map");
const openSettingsButton = must<HTMLButtonElement>("#open-settings");
const closeSettingsButton = must<HTMLButtonElement>("#close-settings");
const settingsPanel = must<HTMLDivElement>("#settings-panel");
const settingsContent = must<HTMLDivElement>("#settings-content");
const viewportSummary = must<HTMLSpanElement>("#viewport-summary");
const viewportDetail = must<HTMLSpanElement>("#viewport-detail");
const modeIndicator = must<HTMLSpanElement>("#mode-indicator");
const modeDetail = must<HTMLSpanElement>("#mode-detail");

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

let map: Map;
let collections: CollectionRecord[] = [];
let lastData: MapObjectsResponse = { places: [], tracks: [] };
let addPlaceMode = false;
let pendingPlace: PendingPlaceState | null = null;
let areaSelectionMode = false;
let areaSelection: AreaSelectionState = { start: null, end: null };
const settingsState: SettingsState = {
  isOpen: false,
  isBusy: false,
  builds: [],
  chunks: [],
  jobs: [],
  selectedBuildKey: "",
};

const filters: FiltersState = {
  objectType: "",
  collectionId: "",
  tag: "",
  startsAfter: "",
  endsBefore: "",
};

void bootstrap();

async function bootstrap(): Promise<void> {
  const basemap = await applyBasemapConfig();

  map = new maplibregl.Map({
    container: "map",
    style: basemap.style_url ?? defaultStyle,
    center: [153.0251, -27.4698],
    zoom: 3,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.on("load", () => {
    ensureOverlayLayers();
    updateSelectionSource();
    void refreshMapData();
  });
  map.on("moveend", () => {
    void refreshMapData();
  });
  map.on("click", (event) => {
    if (areaSelectionMode) {
      handleAreaSelectionClick(event.lngLat.lng, event.lngLat.lat);
      return;
    }
    if (addPlaceMode) {
      openPlaceDrawer({
        latitude: Number(event.lngLat.lat.toFixed(6)),
        longitude: Number(event.lngLat.lng.toFixed(6)),
      });
    }
  });

  wireEventHandlers();
  await refreshCollections();
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
  filterCollection.addEventListener("change", async () => {
    filters.collectionId = filterCollection.value;
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

  toggleAddPlaceButton.addEventListener("click", () => {
    areaSelectionMode = false;
    clearAreaSelection();
    addPlaceMode = !addPlaceMode;
    pendingPlace = null;
    updateModeUi();
    if (!addPlaceMode) {
      renderDrawerEmpty();
    } else {
      updateDrawerMessage("Click on the map to drop a new place.");
    }
  });

  refreshMapButton.addEventListener("click", async () => {
    await refreshMapData();
  });

  openSettingsButton.addEventListener("click", async () => {
    settingsState.isOpen = true;
    settingsPanel.classList.remove("hidden");
    await refreshSettingsData();
  });

  closeSettingsButton.addEventListener("click", () => {
    settingsState.isOpen = false;
    settingsPanel.classList.add("hidden");
  });
}

async function refreshCollections(): Promise<void> {
  collections = await fetchJson<CollectionRecord[]>("/api/collections");
  renderCollections();
  await refreshMapData();
}

function renderCollections(): void {
  filterCollection.innerHTML = `<option value="">All</option>${collections
    .map((collection) => `<option value="${collection.id}">${escapeHtml(collection.name)} · ${escapeHtml(collection.kind)}</option>`)
    .join("")}`;
  filterCollection.value = filters.collectionId;

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

async function refreshMapData(): Promise<void> {
  if (!map || !map.isStyleLoaded()) {
    return;
  }

  const bounds = map.getBounds();
  const params = new URLSearchParams({
    min_lat: String(bounds.getSouth()),
    min_lon: String(bounds.getWest()),
    max_lat: String(bounds.getNorth()),
    max_lon: String(bounds.getEast()),
  });

  if (filters.objectType) params.set("object_type", filters.objectType);
  if (filters.collectionId) params.set("collection_id", filters.collectionId);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.startsAfter) params.set("starts_after", new Date(filters.startsAfter).toISOString());
  if (filters.endsBefore) params.set("ends_before", new Date(filters.endsBefore).toISOString());

  lastData = await fetchJson<MapObjectsResponse>(`/api/map-objects?${params.toString()}`);
  updateOverlaySources();
  viewportSummary.textContent = `${lastData.tracks.length} tracks · ${lastData.places.length} places`;
  viewportDetail.textContent = describeBounds(bounds.toArray() as LngLatBoundsLike);
}

function ensureOverlayLayers(): void {
  if (!map.getSource("places")) {
    map.addSource("places", {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }

  if (!map.getSource("tracks")) {
    map.addSource("tracks", {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }

  if (!map.getSource("selection-box")) {
    map.addSource("selection-box", {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }

  if (!map.getLayer("tracks-line")) {
    map.addLayer({
      id: "tracks-line",
      type: "line",
      source: "tracks",
      paint: {
        "line-color": "#bb5f3a",
        "line-width": 4,
        "line-opacity": 0.9,
      },
    });
    map.on("click", "tracks-line", (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const trackId = String(feature.properties?.id ?? "");
      const track = lastData.tracks.find((item) => item.id === trackId);
      if (track) {
        renderTrackDetail(track);
      }
    });
  }

  if (!map.getLayer("places-circle")) {
    map.addLayer({
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
    map.on("click", "places-circle", (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const placeId = String(feature.properties?.id ?? "");
      const place = lastData.places.find((item) => item.id === placeId);
      if (place) {
        renderPlaceDetail(place);
      }
    });
  }

  if (!map.getLayer("selection-fill")) {
    map.addLayer({
      id: "selection-fill",
      type: "fill",
      source: "selection-box",
      paint: {
        "fill-color": "#2e7764",
        "fill-opacity": 0.12,
      },
    });
  }

  if (!map.getLayer("selection-outline")) {
    map.addLayer({
      id: "selection-outline",
      type: "line",
      source: "selection-box",
      paint: {
        "line-color": "#2e7764",
        "line-width": 2,
        "line-dasharray": [2, 2],
      },
    });
  }
}

function updateOverlaySources(): void {
  const trackSource = map.getSource("tracks");
  const placeSource = map.getSource("places");
  if (trackSource?.type === "geojson") {
    trackSource.setData(buildTrackFeatureCollection(lastData.tracks));
  }
  if (placeSource?.type === "geojson") {
    placeSource.setData(buildPlaceFeatureCollection(lastData.places));
  }
}

function renderDrawerEmpty(): void {
  detailPanel.innerHTML = `
    <div class="drawer-empty">
      Select a track or place on the map, or switch to place mode and click on the map to capture a new point.
    </div>
  `;
}

function updateDrawerMessage(message: string): void {
  detailPanel.innerHTML = `<div class="drawer-empty">${escapeHtml(message)}</div>`;
}

function renderTrackDetail(track: TrackRecord): void {
  detailPanel.innerHTML = `
    <div class="drawer-card">
      <h2>${escapeHtml(track.title ?? "Untitled track")}</h2>
      <div class="meta-row">
        <span class="meta-pill">Track</span>
        ${track.distance_m ? `<span class="meta-pill">${Math.round(track.distance_m)} m</span>` : ""}
        ${track.start_time ? `<span class="meta-pill">${escapeHtml(new Date(track.start_time).toLocaleString())}</span>` : ""}
      </div>
      ${track.notes ? `<div>${escapeHtml(track.notes)}</div>` : ""}
      <div class="detail-list">
        <div><strong>Bounds</strong><br />${track.min_lat.toFixed(4)}, ${track.min_lon.toFixed(4)} → ${track.max_lat.toFixed(4)}, ${track.max_lon.toFixed(4)}</div>
      </div>
    </div>
  `;
}

function renderPlaceDetail(place: PlaceRecord): void {
  detailPanel.innerHTML = `
    <div class="drawer-card">
      <h2>${escapeHtml(place.name)}</h2>
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
}

function openPlaceDrawer(place: PendingPlaceState): void {
  pendingPlace = place;
  addPlaceMode = true;
  areaSelectionMode = false;
  clearAreaSelection();
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
            Visit start
            <input name="visit_start" type="datetime-local" />
          </label>
          <label>
            Visit end
            <input name="visit_end" type="datetime-local" />
          </label>
        </div>
        <label>
          Tags
          <input name="tags" type="text" placeholder="future, walk" />
        </label>
        <div>
          <strong>Collections</strong>
          <div class="checklist">
            ${collections.length
              ? collections
                  .map(
                    (collection) => `
                      <label>
                        <input type="checkbox" name="collection_ids" value="${collection.id}" />
                        <span>${escapeHtml(collection.name)} · ${escapeHtml(collection.kind)}</span>
                      </label>`,
                  )
                  .join("")
              : `<div class="drawer-empty">Create a collection first if you want to group this place.</div>`}
          </div>
        </div>
      </div>
      <div class="inline-actions">
        <button type="submit">Save place</button>
        <button id="cancel-place" class="secondary" type="button">Cancel</button>
      </div>
    </form>
  `;

  const placeForm = must<HTMLFormElement>("#place-form");
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

async function refreshSettingsData(): Promise<void> {
  if (!settingsState.isOpen) {
    return;
  }

  settingsState.isBusy = true;
  renderSettings();
  const [builds, local, jobs] = await Promise.all([
    fetchJson<MapsBuildsResponse>("/api/settings/maps/builds"),
    fetchJson<MapsLocalResponse>("/api/settings/maps/local"),
    fetchJson<MapsJobsResponse>("/api/settings/maps/jobs"),
  ]);
  settingsState.builds = builds.builds;
  settingsState.chunks = local.chunks;
  settingsState.jobs = jobs.jobs.slice(0, 8);
  settingsState.selectedBuildKey =
    local.selected_build_key ?? builds.selected_build_key ?? builds.builds[0]?.key ?? "";
  settingsState.isBusy = false;
  renderSettings();
}

function renderSettings(): void {
  if (!settingsState.isOpen) {
    return;
  }

  const staleCount = settingsState.chunks.filter((chunk) => chunk.stale).length;
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
      <div class="status ${staleCount ? "warn" : ""}">
        ${settingsState.isBusy ? "Working…" : staleCount ? `${staleCount} chunks are stale for ${escapeHtml(settingsState.selectedBuildKey || "the selected build")}.` : "Managed PMTiles are current for the selected build."}
      </div>
    </section>

    <section class="settings-section">
      <div class="section-heading">Area Extract</div>
      <div class="field-grid">
        <label>
          Label
          <input id="area-label" type="text" placeholder="Brisbane detail" value="Regional detail" />
        </label>
        <label>
          Max zoom
          <input id="area-max-zoom" type="number" min="0" max="12" value="8" />
        </label>
        <div class="inline-actions">
          <button id="select-area" class="secondary" type="button">${areaSelectionMode ? "Area mode on" : "Select area"}</button>
          <button id="create-area-extract" type="button" ${!hasCompleteAreaSelection() || !settingsState.selectedBuildKey ? "disabled" : ""}>Create extract</button>
        </div>
        <div class="status">
          ${describeAreaSelection()}
        </div>
      </div>
    </section>

    <section class="settings-section">
      <div class="section-heading">Active Layers</div>
      <form id="active-layers-form" class="field-grid">
        ${settingsState.chunks.length
          ? settingsState.chunks
              .map((chunk) => renderChunkEditor(chunk, settingsState.selectedBuildKey))
              .join("")
          : `<div class="drawer-empty">No managed PMTiles chunks yet.</div>`}
        <button type="submit" ${settingsState.isBusy || !settingsState.selectedBuildKey ? "disabled" : ""}>Save active stack</button>
      </form>
    </section>

    <section class="settings-section">
      <div class="section-heading">Jobs</div>
      <div class="field-grid">
        ${settingsState.jobs.length
          ? settingsState.jobs
              .map(
                (job) => `
                  <div class="job-row">
                    <strong>${escapeHtml(job.kind)}</strong>
                    <span>${escapeHtml(job.status)} · ${escapeHtml(job.build_key)}</span>
                    ${job.error_message ? `<span class="job-error">${escapeHtml(job.error_message)}</span>` : ""}
                  </div>`,
              )
              .join("")
          : `<div class="drawer-empty">No map jobs yet.</div>`}
      </div>
    </section>
  `;

  wireSettingsPanel();
}

function wireSettingsPanel(): void {
  const buildSelect = settingsContent.querySelector<HTMLSelectElement>("#settings-build");
  const refreshBuildsButton = settingsContent.querySelector<HTMLButtonElement>("#refresh-builds");
  const worldTo6Button = settingsContent.querySelector<HTMLButtonElement>("#world-to-6");
  const rebuildStaleButton = settingsContent.querySelector<HTMLButtonElement>("#rebuild-stale");
  const selectAreaButton = settingsContent.querySelector<HTMLButtonElement>("#select-area");
  const createAreaExtractButton = settingsContent.querySelector<HTMLButtonElement>("#create-area-extract");
  const activeLayersForm = settingsContent.querySelector<HTMLFormElement>("#active-layers-form");

  buildSelect?.addEventListener("change", () => {
    settingsState.selectedBuildKey = buildSelect.value;
    renderSettings();
  });

  refreshBuildsButton?.addEventListener("click", async () => {
    await refreshSettingsData();
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

  selectAreaButton?.addEventListener("click", () => {
    addPlaceMode = false;
    areaSelectionMode = !areaSelectionMode;
    if (!areaSelectionMode) {
      clearAreaSelection();
    }
    updateModeUi();
    renderSettings();
  });

  createAreaExtractButton?.addEventListener("click", async () => {
    if (!settingsState.selectedBuildKey || !hasCompleteAreaSelection()) return;
    const labelInput = settingsContent.querySelector<HTMLInputElement>("#area-label");
    const maxZoomInput = settingsContent.querySelector<HTMLInputElement>("#area-max-zoom");
    const bounds = normalizedAreaBounds();
    if (!bounds) return;
    await runManagedMapsAction(async () => {
      await postJson("/api/settings/maps/area-extract", {
        build_key: settingsState.selectedBuildKey,
        label: labelInput?.value.trim() || "Regional detail",
        min_lon: bounds.minLon,
        min_lat: bounds.minLat,
        max_lon: bounds.maxLon,
        max_lat: bounds.maxLat,
        max_zoom: Number(maxZoomInput?.value || "8"),
      });
      await waitForMapJobs();
      areaSelectionMode = false;
      clearAreaSelection();
      updateModeUi();
    });
  });

  activeLayersForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!settingsState.selectedBuildKey) return;
    const rows = Array.from(settingsContent.querySelectorAll<HTMLElement>("[data-chunk-id]"));
    const layers = rows.map((row) => {
      const chunkId = row.dataset.chunkId ?? "";
      const enabled = row.querySelector<HTMLInputElement>("input[name='enabled']")?.checked ?? false;
      const displayOrder = Number(
        row.querySelector<HTMLInputElement>("input[name='display_order']")?.value || "0",
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
      await refreshBasemapStyle();
    });
  });
}

async function runManagedMapsAction(action: () => Promise<void>): Promise<void> {
  settingsState.isBusy = true;
  renderSettings();
  await action();
  settingsState.isBusy = false;
  await refreshSettingsData();
  await refreshBasemapStyle();
}

async function waitForMapJobs(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const jobs = await fetchJson<MapsJobsResponse>("/api/settings/maps/jobs");
    settingsState.jobs = jobs.jobs.slice(0, 8);
    renderSettings();
    if (
      jobs.jobs.every((job) => job.status !== "queued" && job.status !== "running")
    ) {
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
    updateDrawerMessage("Select the opposite corner for the PMTiles extract.");
  } else {
    areaSelection.end = { lng, lat };
    updateDrawerMessage("Area selected. Set the extract details in Settings and create the chunk.");
  }
  updateSelectionSource();
  renderSettings();
  updateModeUi();
}

function updateSelectionSource(): void {
  if (!map || !map.getSource("selection-box")) {
    return;
  }
  const source = map.getSource("selection-box");
  if (source?.type === "geojson") {
    source.setData(buildSelectionFeatureCollection());
  }
}

function buildSelectionFeatureCollection(): GeoJSON.FeatureCollection {
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

function normalizedAreaBounds():
  | { minLon: number; minLat: number; maxLon: number; maxLat: number }
  | null {
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
    return "Choose Select area, then click two corners on the map to define a regional PMTiles extract.";
  }
  if (!bounds) {
    return "First corner captured. Click the opposite corner on the map.";
  }
  return `${bounds.minLat.toFixed(3)}, ${bounds.minLon.toFixed(3)} → ${bounds.maxLat.toFixed(3)}, ${bounds.maxLon.toFixed(3)}`;
}

function renderChunkEditor(chunk: MapsChunkRecord, selectedBuildKey: string): string {
  const selectedArchive = chunk.archives.find((archive) => archive.build_key === selectedBuildKey);
  const archiveSummary = selectedArchive
    ? `${selectedArchive.tile_type.toUpperCase()} · z${selectedArchive.min_zoom}-${selectedArchive.max_zoom}`
    : "No materialized archive for this build";
  return `
    <div class="chunk-card" data-chunk-id="${chunk.id}">
      <div class="chunk-card-header">
        <div>
          <strong>${escapeHtml(chunk.label)}</strong>
          <div class="chunk-card-meta">
            <span>${escapeHtml(chunk.kind)}</span>
            <span>${escapeHtml(archiveSummary)}</span>
            ${chunk.stale ? `<span class="chunk-stale">stale</span>` : ""}
          </div>
        </div>
        <label class="toggle">
          <input name="enabled" type="checkbox" ${chunk.enabled ? "checked" : ""} />
          <span>Active</span>
        </label>
      </div>
      <div class="settings-row">
        <label>
          Order
          <input name="display_order" type="number" value="${chunk.display_order}" />
        </label>
        <div class="chunk-card-bounds">
          ${describeChunkBounds(chunk)}
        </div>
      </div>
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
  toggleAddPlaceButton.textContent = addPlaceMode ? "Place mode on" : "Add place";
  if (areaSelectionMode) {
    modeIndicator.textContent = "Area extract";
    modeDetail.textContent = areaSelection.start
      ? "Click the opposite corner to finish the PMTiles extract box."
      : "Click a first corner on the map for the PMTiles extract box.";
    return;
  }
  modeIndicator.textContent = addPlaceMode ? "Place mode" : "Browse";
  modeDetail.textContent = addPlaceMode
    ? "Click on the map to drop a new point of interest."
    : "Move, filter, and select tracks or places.";
}

function buildTrackFeatureCollection(tracks: TrackRecord[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: tracks.map((track) => ({
      type: "Feature",
      properties: {
        id: track.id,
        title: track.title,
      },
      geometry: JSON.parse(track.geometry_json) as GeoJSON.Geometry,
    })),
  };
}

function buildPlaceFeatureCollection(places: PlaceRecord[]): GeoJSON.FeatureCollection {
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

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

function describeBounds(bounds: LngLatBoundsLike): string {
  const normalized = maplibregl.LngLatBounds.convert(bounds);
  return `${normalized.getSouth().toFixed(2)}, ${normalized.getWest().toFixed(2)} → ${normalized.getNorth().toFixed(2)}, ${normalized.getEast().toFixed(2)}`;
}

function buildBasemapLabel(basemap: BasemapConfig): string {
  if (!basemap.enabled) {
    return "No basemap configured";
  }
  const tileType = basemap.tile_type ? basemap.tile_type.toUpperCase() : "PMTiles";
  return `PMTiles ${tileType} · z${basemap.min_zoom ?? 0}-${basemap.max_zoom ?? 0}`;
}

async function applyBasemapConfig(): Promise<BasemapConfig> {
  const basemap = await fetchJson<BasemapConfig>("/api/basemap");
  basemapStatus.className = basemap.message ? "status warn" : "status";
  basemapStatus.textContent = basemap.message ?? buildBasemapLabel(basemap);
  return basemap;
}

async function refreshBasemapStyle(): Promise<void> {
  const basemap = await applyBasemapConfig();
  if (!map) {
    return;
  }

  map.setStyle(basemap.style_url ?? defaultStyle);
  map.once("styledata", () => {
    if (!map.isStyleLoaded()) {
      return;
    }
    ensureOverlayLayers();
    updateSelectionSource();
    void refreshMapData();
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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
