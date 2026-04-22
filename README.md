# map-travel

`map-travel` is a Rust-backed, browser-based travel mapping app.

It currently supports:

- bootstrapping a local SQLite database on first run
- generating a stable local owner ID with no login flow
- importing GPX tracks
- creating places and collections
- filtering map objects by bounds, collection, object type, tag, and date range
- rendering a map-first browser UI built with MapLibre GL JS
- serving PMTiles-backed basemaps through the Rust server

## Stack

- Backend: Rust, `axum`, `sea-orm`, SQLite
- Migrations: SeaORM migration crate in `migration/`
- Frontend: Vite, TypeScript, MapLibre GL JS
- Tiles: Rust `pmtiles` crate on the server side

## Repository Layout

- `src/main.rs`: app entrypoint and static file serving
- `src/api.rs`: HTTP API routes for collections, places, GPX import, map queries, and basemap endpoints
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

Start the server:

```bash
cargo run
```

By default the app listens on `127.0.0.1:3000` and uses `map-travel.sqlite` in the repo root.

## Environment Variables

- `MAP_TRAVEL_DATABASE_URL`: SQLite connection string
  - default: `sqlite://map-travel.sqlite?mode=rwc`
- `MAP_TRAVEL_LISTEN_ADDR`: bind address for the HTTP server
  - default: `127.0.0.1:3000`
- `MAP_TRAVEL_PMTILES_PATH`: optional path to a PMTiles archive
- `MAP_TRAVEL_PMTILES_STYLE_PATH`: optional path to a MapLibre style JSON file for vector PMTiles archives

### PMTiles Notes

If `MAP_TRAVEL_PMTILES_PATH` is not set, the app still runs and reports that no basemap is configured.

Raster PMTiles archives can be served directly.

Vector PMTiles archives need a style JSON file via `MAP_TRAVEL_PMTILES_STYLE_PATH`, because the frontend needs a MapLibre style to render vector layers.

## API Surface

Current routes:

- `GET /api/basemap`
- `GET /api/basemap/style.json`
- `GET /api/basemap/tiles/{z}/{x}/{y}`
- `GET /api/collections`
- `POST /api/collections`
- `POST /api/places`
- `POST /api/tracks/import`
- `GET /api/map-objects`

This is still an early v1 surface. There are no edit/delete routes yet.

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

## Known Gaps

- no update/delete API yet
- no photo or attachment handling
- no collaborative or multi-account model
- no frontend hot-reload dev server integration with the Rust app yet
- vector PMTiles rendering depends on a supplied style JSON file
