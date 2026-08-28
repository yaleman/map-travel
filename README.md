# map-travel

`map-travel` is a Rust-backed, browser-based travel mapping app.

It currently supports:

- bootstrapping PostgreSQL with SeaORM migrations on startup
- generating a stable local owner ID with no login flow
- importing GPX tracks with embedded metadata and linking them to one or more collections
- creating places and collections
- filtering map objects by bounds, collection, object type, tag, and date range
- searching places and tracks globally by name and metadata
- rendering a map-first browser UI built with MapLibre GL JS
- serving PMTiles-backed basemaps through the Rust server
- serving OpenAPI documentation and vendored Swagger UI assets
- vendoring Protomaps basemap style, sprite, and font assets as part of the frontend build

## Stack

- Backend: Rust, `axum`, `sea-orm`, PostgreSQL
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
- Docker for local development and integration tests
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

Start the complete local stack:

```bash
docker compose up --build
```

Compose exposes the app at `http://127.0.0.1:3000`, starts PostgreSQL 17, and persists both database and managed-map data in named volumes. `MAP_TRAVEL_POSTGRES_PASSWORD` and `MAP_TRAVEL_PORT` can override the development defaults.

To run the process directly, set `MAP_TRAVEL_DATABASE_URL` and build the frontend first. The process defaults to `0.0.0.0:8080` and stores managed PMTiles downloads in `maps/` unless overridden.

## Environment Variables

- `MAP_TRAVEL_DATABASE_URL`: required PostgreSQL connection string
- `MAP_TRAVEL_DATABASE_MAX_CONNECTIONS`: maximum connections held by each process
  - default: `16`
- `MAP_TRAVEL_DATABASE_CONNECT_TIMEOUT_SECONDS`: PostgreSQL connection timeout
  - default: `10`
- `MAP_TRAVEL_LISTEN_ADDR`: bind address for the HTTP server
  - default: `0.0.0.0:8080`
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

- `GET /health/live`
- `GET /health/ready`
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

The integration tests use the `testcontainers` crate to start disposable PostgreSQL 17 backends. Docker must be running.

## Container images

`Dockerfile` builds the frontend and Rust server into a non-root distroless runtime image. Runtime configuration is supplied through environment variables, logs go to standard output, and `SIGTERM` triggers graceful shutdown.

GitHub Actions uses Docker's maintained [`github-builder`](https://github.com/docker/github-builder) workflow to build `linux/amd64` and `linux/arm64` images and publish them to `ghcr.io/yaleman/map-travel`. Every published build receives a UTC `build-YYYYMMDD-HHmmss` tag, pushes to `main` also publish `latest`, and `v*` Git tags publish their semantic version without the `v` prefix. Same-repository pull requests publish the tested image under the workflow commit SHA; fork pull requests build without publishing. Published images include provenance and an SBOM.

Run the published image against any reachable PostgreSQL service and mount persistent storage for managed PMTiles:

```bash
docker run --rm \
  --publish 127.0.0.1:8080:8080 \
  --env MAP_TRAVEL_DATABASE_URL='postgres://USER:PASSWORD@POSTGRES_HOST:5432/map_travel' \
  --env MAP_TRAVEL_MANAGED_MAPS_DIR=/data/maps \
  --volume map-travel-maps:/data/maps \
  ghcr.io/yaleman/map-travel:latest
```

The container exposes port `8080`; `/health/live` is a process liveness check and `/health/ready` verifies PostgreSQL connectivity. Orchestrators should inject the database URL as a secret and provide persistent or shared storage at the configured managed-maps directory.

## Current Behaviour

- the app is intentionally single-user
- there is no authentication in v1
- data is public by default in the current model
- the UI is map-first rather than dashboard-first
- collection kinds are currently `trip`, `future`, `past`, and `general`
- GPX import can assign every imported track to multiple collections; the active collection filter is preselected, and links can be changed from the track editor
- collection selectors are collapsed, case-insensitive searchable multi-selects; map filters match objects in any selected collection
- track names come from GPX track names, falling back to document metadata names; the track drawer shows saved embedded GPX metadata
- failed managed-map jobs can be retried from the same build and chunk or removed from Settings

## Known Gaps

- no photo or attachment handling
- no collaborative or multi-account model
- no frontend hot-reload dev server integration with the Rust app yet
- the vendored basemap bundle is refreshed by the frontend build rather than being generated by Cargo alone
