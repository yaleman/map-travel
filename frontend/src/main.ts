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

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App container not found");
}

app.innerHTML = `
  <div class="shell">
    <aside class="panel">
      <div class="panel-scroll">
        <div class="brand">
          <h1>Map Travel</h1>
          <span class="pill">v1</span>
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
          <div id="collection-list" class="collection-list" style="margin-top: 14px;"></div>
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

const filters: FiltersState = {
  objectType: "",
  collectionId: "",
  tag: "",
  startsAfter: "",
  endsBefore: "",
};

void bootstrap();

async function bootstrap(): Promise<void> {
  const basemap = await fetchJson<BasemapConfig>("/api/basemap");
  basemapStatus.className = basemap.message ? "status warn" : "status";
  basemapStatus.textContent = basemap.message ?? buildBasemapLabel(basemap);

  map = new maplibregl.Map({
    container: "map",
    style: basemap.style_url ?? defaultStyle,
    center: [153.0251, -27.4698],
    zoom: 3,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.on("load", () => {
    ensureOverlayLayers();
    void refreshMapData();
  });
  map.on("moveend", () => {
    void refreshMapData();
  });
  map.on("click", (event) => {
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

function updateModeUi(): void {
  toggleAddPlaceButton.classList.toggle("active", addPlaceMode);
  toggleAddPlaceButton.textContent = addPlaceMode ? "Place mode on" : "Add place";
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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw await buildHttpError(response);
  }
  return (await response.json()) as T;
}

async function postJson(url: string, payload: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await buildHttpError(response);
  }
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

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Expected element ${selector}`);
  }
  return element;
}
