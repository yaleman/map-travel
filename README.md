# map-travel

`map-travel` is a Rust-backed, browser-based travel mapping app.

It currently supports:

- bootstrapping a local SQLite database on first run
- generating a stable local owner ID with no login flow
- importing GPX tracks and linking them to one or more collections
- creating places and collections
- filtering map objects by bounds, collection, object type, tag, and date range
- searching places and tracks globally by name and metadata
- rendering a map-first browser UI built with MapLibre GL JS
- serving PMTiles-backed basemaps through the Rust server
- serving OpenAPI documentation and vendored Swagger UI assets
- vendoring Protomaps basemap style, sprite, and font assets as part of the frontend build

## Stack

- Backend: Rust, `axum`, `sea-orm`, SQLite
- Migrations: SeaORM migration crate in `migration/`
- Frontend: Vite, TypeScript, MapLibre GL JS
- Tiles: Rust `pmtiles` crate on the server side

## Repository Layout

- `src/main.rs`: app entrypoint and static file serving
- `src/api.rs`: HTTP API routes for collections, places, GPX import, map queries, search, and OpenAPI docs
- `src/app.rs`: startup, database bootstrap, owner ID generation, and PMTiles reader setup
- `src/entities.rs`: SeaORM entity definitions
- `migration/`: SeaORM migration crate
- `frontend/`: browser app source and build output
- `tests/`: integration tests for bootstrap, CRUD/query behavior, and GPX import

## Requirements

- Rust toolchain with `cargo`
- `pnpm`
- optionally `mise` if you want tool management via `mise.toml`

## Install Dependencies

Rust dependencies are managed with `cargo`.

Frontend dependencies are managed with `pnpm`:

```bash
pnpm --dir frontend install
```

## Running The App

Build the frontend first:

```bash
pnpm --dir frontend build
```

That build now vendors the basemap assets into `vendor/protomaps/` before Vite emits `frontend/dist/`.

Start the server:

```bash
cargo run
```

By default the app listens on `127.0.0.1:3000` and uses `map-travel.sqlite` in the repo root.
Managed PMTiles downloads are stored in `maps/` in the repo root unless overridden.

## Environment Variables

- `MAP_TRAVEL_DATABASE_URL`: SQLite connection string
  - default: `sqlite://map-travel.sqlite?mode=rwc`
- `MAP_TRAVEL_LISTEN_ADDR`: bind address for the HTTP server
  - default: `127.0.0.1:3000`
- `MAP_TRAVEL_PMTILES_PATH`: optional path to a PMTiles archive
- `MAP_TRAVEL_PMTILES_STYLE_PATH`: optional path to a MapLibre style JSON file for vector PMTiles archives
- `MAP_TRAVEL_VENDORED_BASEMAP_DIR`: optional override for the vendored basemap asset directory
  - default: `vendor/protomaps`
- `MAP_TRAVEL_MANAGED_MAPS_DIR`: optional override for the managed PMTiles download/cache directory
  - default: `maps/`

### PMTiles Notes

If `MAP_TRAVEL_PMTILES_PATH` is not set, the app still runs and reports that no basemap is configured.

Raster PMTiles archives can be served directly.

Managed vector PMTiles basemaps use the vendored Protomaps style/sprite/font bundle in `vendor/protomaps/`.
Building the frontend refreshes that bundle automatically.

## API Surface

The OpenAPI schema is available at `/api-docs/openapi.json`.
Swagger UI is available at `/swagger-ui/` and is served from vendored crate assets.

Current routes:

- `GET /api/basemap`
- `GET /api/basemap/style.json`
- `GET /api/basemap/tilejson.json`
- `GET /api/basemap/sprite.json`
- `GET /api/basemap/sprite.png`
- `GET /api/basemap/sprite@2x.json`
- `GET /api/basemap/sprite@2x.png`
- `GET /api/basemap/fonts/{fontstack}/{range}.pbf`
- `GET /api/basemap/tiles/{z}/{x}/{y}`
- `GET /api/collections`
- `POST /api/collections`
- `POST /api/places`
- `PATCH /api/places/{place_id}`
- `DELETE /api/places/{place_id}`
- `POST /api/tracks/import`
- `PATCH /api/tracks/{track_id}`
- `DELETE /api/tracks/{track_id}`
- `GET /api/map-objects`
- `GET /api/search`
- `GET /api/settings/maps/builds`
- `GET /api/settings/maps/local`
- `GET /api/settings/maps/jobs`
- `POST /api/settings/maps/jobs/{job_id}/cancel`
- `POST /api/settings/maps/world-to-6`
- `POST /api/settings/maps/area-extract`
- `POST /api/settings/maps/active-layers`
- `POST /api/settings/maps/rebuild-chunks`

`GET /api/map-objects` is bounds-scoped for the current map viewport.
`GET /api/search?query=...` searches globally across place names, categories, notes, tags, collection names, and track titles, original filenames, notes, tags, and collection names.

## Development

Frontend build:

```bash
pnpm --dir frontend build
```

Backend tests:

```bash
cargo test
```

The integration tests use in-memory SQLite databases built at runtime.

## Current Behaviour

- the app is intentionally single-user
- there is no authentication in v1
- data is public by default in the current model
- the UI is map-first rather than dashboard-first
- collection kinds are currently `trip`, `future`, `past`, and `general`
- GPX import can assign every imported track to multiple collections; the active collection filter is preselected, and links can be changed from the track editor

## Known Gaps

- no photo or attachment handling
- no collaborative or multi-account model
- no frontend hot-reload dev server integration with the Rust app yet
- the vendored basemap bundle is refreshed by the frontend build rather than being generated by Cargo alone
