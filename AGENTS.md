# Agents

You're not done with a task until you run `mise check` and there's no issues.

## Repository Rules

- Keep the implementation simple and direct.
- Prefer reducing sprawl over adding new abstraction layers.
- Do not plan for extensibility or backwards compatibility unless explicitly asked.
- Use package managers to add or remove dependencies instead of hand-editing lockfiles.
- Use `pnpm`, not `npm`.
- Avoid OpenSSL-backed choices when there is a practical Rustls or platform-safe alternative.

## Current Architecture

- `src/` contains the application crate.
- `migration/` contains the SeaORM migration crate.
- `frontend/` contains the Vite + TypeScript browser app.
- `tests/` contains integration tests that exercise the HTTP surface and startup behavior.

The server serves `frontend/dist/`, so frontend changes normally need a fresh `pnpm --dir frontend build` before running `cargo run`.
That frontend build also vendors the basemap style, sprite, and font assets into `vendor/protomaps/`.

## Database Rules

- Use PostgreSQL for the app database.
- Use `sea-orm` for database access.
- Never use the SeaORM CLI.
- Manage schema changes only through the migration crate in `migration/`.
- Production and tests use PostgreSQL through SeaORM.
- Integration tests start disposable PostgreSQL 17 backends with `testcontainers`; Docker must be available when running the Rust test suite.

## Mapping Rules

- PMTiles is a required part of the mapping stack.
- Keep PMTiles handling in the Rust server unless there is a strong reason not to.
- Map rendering in the browser should continue to use MapLibre GL JS unless the repo is explicitly being reworked.
- Managed vector PMTiles basemaps should read from the vendored asset bundle in `vendor/protomaps/`, not from runtime network fetches.
- If working on vector PMTiles support, keep the browser fully local: sprite and glyph URLs must stay inside the app.

## Backend Conventions

- Keep route behavior in `src/api.rs`.
- Keep API documentation current with `utoipa` annotations when changing HTTP routes or DTOs.
- Keep Swagger UI served from `utoipa-swagger-ui` with the `vendored` feature.
- Keep startup/bootstrap concerns in `src/app.rs`.
- Keep entity definitions in `src/entities.rs`.
- Handle errors cleanly in production code.
- In Rust code, use `.expect(...)` only in tests.

## Frontend Conventions

- Keep the UI map-first.
- Avoid adding a dashboard-first homepage unless the task explicitly asks for it.
- The main layout should remain:
  - left-side controls
  - central map
  - right-side details/editor drawer
- Keep right-side search behavior split between client-side in-view filtering while typing and backend global search on submit.
- Avoid subtitles in the UI unless they are actually necessary.

## Documentation Rules

- Update `README.md` and `AGENTS.md` together when repo-level behavior or workflow changes.
- In documentation and comments, use project-relative paths.
- Do not write full on-disk paths into repo docs.

## Validation

For most code changes, run:

```bash
cargo test
pnpm --dir frontend build
```

If startup or static serving changed, also run:

```bash
cargo run
```

Then verify:

- `/` serves the frontend
- `/api/basemap` returns sensible config for the current environment
- `/api-docs/openapi.json` serves the OpenAPI schema
- `/swagger-ui/` serves the vendored Swagger UI

Container and runtime configuration changes must keep `compose.yaml`, `Dockerfile`, and `.github/workflows/build-container.yml` aligned. The application database URL is required at runtime and must come from `MAP_TRAVEL_DATABASE_URL`.

## Current Product Constraints

- v1 is single-user with a generated stable owner ID
- no auth flow in v1
- GPX import is first-class
- GPX track names use track metadata with document metadata as a fallback, and the track drawer exposes embedded metadata
- GPX tracks can belong to multiple collections; import preselects the active collection filter and the track editor manages the final memberships
- collection selectors use the shared collapsed, case-insensitive searchable multi-select; map filters match any selected collection
- failed managed-map jobs can be retried from the same build and chunk or removed from Settings
- objects can belong to multiple collections
- collection kinds are `trip`, `future`, `past`, and `general`
- privacy and publishing are minimal in the current build
