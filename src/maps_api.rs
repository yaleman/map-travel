use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::{
    app::AppContext,
    error::{AppError, AppResult, ErrorBody},
    maps::{
        ActiveLayerUpdate, AreaExtractSpec, BuildCatalogResponse, EnqueuedJobResponse,
        JobListResponse, LocalMapsResponse, ManagedBasemapSummary, RebuildChunksResponse,
        tile_bounds_for_coord, tile_range_for_bbox, validate_bbox,
    },
};

const MAX_MISSING_TILE_ZOOM: u8 = 12;
const MAX_MISSING_TILE_SCAN: u32 = 4096;

pub fn build_router() -> Router<Arc<AppContext>> {
    Router::new()
        .route("/api/settings/maps/builds", get(get_builds))
        .route("/api/settings/maps/local", get(get_local_maps))
        .route("/api/settings/maps/jobs", get(get_jobs))
        .route(
            "/api/settings/maps/jobs/{job_id}/cancel",
            post(post_cancel_job),
        )
        .route("/api/settings/maps/world-to-6", post(post_world_to_6))
        .route("/api/settings/maps/area-extract", post(post_area_extract))
        .route("/api/settings/maps/active-layers", post(post_active_layers))
        .route(
            "/api/settings/maps/rebuild-chunks",
            post(post_rebuild_chunks),
        )
        .route("/api/basemap", get(get_basemap_config))
        .route("/api/basemap/style.json", get(get_basemap_style))
        .route("/api/basemap/fonts/{*font_path}", get(get_basemap_font))
        .route("/api/basemap/sprite.json", get(get_basemap_sprite_json))
        .route("/api/basemap/sprite.png", get(get_basemap_sprite_png))
        .route(
            "/api/basemap/sprite@2x.json",
            get(get_basemap_sprite_json_hidpi),
        )
        .route(
            "/api/basemap/sprite@2x.png",
            get(get_basemap_sprite_png_hidpi),
        )
        .route("/api/basemap/tilejson.json", get(get_basemap_tilejson))
        .route("/api/basemap/missing-tiles", get(get_missing_basemap_tiles))
        .route("/api/basemap/tiles/{z}/{x}/{y}", get(get_basemap_tile))
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct WorldTo6Request {
    build_key: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct AreaExtractRequest {
    build_key: String,
    #[serde(flatten)]
    extract: AreaExtractSpec,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct ActiveLayersRequest {
    selected_build_key: String,
    layers: Vec<ActiveLayerUpdate>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct RebuildChunksRequest {
    build_key: String,
    chunk_ids: Option<Vec<String>>,
}

#[derive(Debug, serde::Serialize, ToSchema)]
pub(crate) struct BasemapConfigResponse {
    enabled: bool,
    style_url: Option<String>,
    tile_type: Option<String>,
    min_zoom: Option<u8>,
    max_zoom: Option<u8>,
    bounds: Option<[f64; 4]>,
    message: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub(crate) struct MissingTilesQuery {
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
    tile_zoom: u8,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct MissingTilesResponse {
    missing: bool,
    tile_zoom: u8,
    missing_tile_count: u32,
    bounds: Option<[f64; 4]>,
    max_zoom: Option<u8>,
}

#[utoipa::path(
    get,
    path = "/api/settings/maps/builds",
    responses(
        (status = 200, description = "Available Protomaps builds", body = BuildCatalogResponse),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_builds(
    State(context): State<Arc<AppContext>>,
) -> AppResult<Json<BuildCatalogResponse>> {
    context.maps().fetch_build_catalog().await.map(Json)
}

#[utoipa::path(
    get,
    path = "/api/settings/maps/local",
    responses(
        (status = 200, description = "Local managed maps", body = LocalMapsResponse),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_local_maps(
    State(context): State<Arc<AppContext>>,
) -> AppResult<Json<LocalMapsResponse>> {
    context.maps().list_local_maps().await.map(Json)
}

#[utoipa::path(
    get,
    path = "/api/settings/maps/jobs",
    responses(
        (status = 200, description = "Managed map jobs", body = JobListResponse),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_jobs(
    State(context): State<Arc<AppContext>>,
) -> AppResult<Json<JobListResponse>> {
    context.maps().list_jobs().await.map(Json)
}

#[utoipa::path(
    post,
    path = "/api/settings/maps/jobs/{job_id}/cancel",
    params(("job_id" = String, Path, description = "Job ID")),
    responses(
        (status = 200, description = "Job cancellation requested"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 409, description = "Conflict", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn post_cancel_job(
    State(context): State<Arc<AppContext>>,
    Path(job_id): Path<String>,
) -> AppResult<StatusCode> {
    context.maps().cancel_job(&job_id).await?;
    Ok(StatusCode::OK)
}

#[utoipa::path(
    post,
    path = "/api/settings/maps/world-to-6",
    request_body = WorldTo6Request,
    responses(
        (status = 201, description = "World-to-6 job queued", body = EnqueuedJobResponse),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 409, description = "Conflict", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn post_world_to_6(
    State(context): State<Arc<AppContext>>,
    Json(request): Json<WorldTo6Request>,
) -> AppResult<(StatusCode, Json<EnqueuedJobResponse>)> {
    let payload = context.maps().queue_world_to_6(&request.build_key).await?;
    Ok((StatusCode::CREATED, Json(payload)))
}

#[utoipa::path(
    post,
    path = "/api/settings/maps/area-extract",
    request_body = AreaExtractRequest,
    responses(
        (status = 201, description = "Area extract job queued", body = EnqueuedJobResponse),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 409, description = "Conflict", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn post_area_extract(
    State(context): State<Arc<AppContext>>,
    Json(request): Json<AreaExtractRequest>,
) -> AppResult<(StatusCode, Json<EnqueuedJobResponse>)> {
    let payload = context
        .maps()
        .queue_area_extract(&request.build_key, request.extract)
        .await?;
    Ok((StatusCode::CREATED, Json(payload)))
}

#[utoipa::path(
    post,
    path = "/api/settings/maps/active-layers",
    request_body = ActiveLayersRequest,
    responses(
        (status = 200, description = "Active layers updated"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn post_active_layers(
    State(context): State<Arc<AppContext>>,
    Json(request): Json<ActiveLayersRequest>,
) -> AppResult<StatusCode> {
    context
        .maps()
        .update_active_layers(&request.selected_build_key, &request.layers)
        .await?;
    Ok(StatusCode::OK)
}

#[utoipa::path(
    post,
    path = "/api/settings/maps/rebuild-chunks",
    request_body = RebuildChunksRequest,
    responses(
        (status = 201, description = "Rebuild jobs queued", body = RebuildChunksResponse),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 409, description = "Conflict", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn post_rebuild_chunks(
    State(context): State<Arc<AppContext>>,
    Json(request): Json<RebuildChunksRequest>,
) -> AppResult<(StatusCode, Json<RebuildChunksResponse>)> {
    let payload = context
        .maps()
        .rebuild_chunks(&request.build_key, request.chunk_ids)
        .await?;
    Ok((StatusCode::CREATED, Json(payload)))
}

#[utoipa::path(
    get,
    path = "/api/basemap",
    responses(
        (status = 200, description = "Basemap configuration", body = BasemapConfigResponse),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_basemap_config(
    State(context): State<Arc<AppContext>>,
    headers: HeaderMap,
) -> AppResult<Json<BasemapConfigResponse>> {
    let base_url = request_base_url(&headers);
    if let Some(summary) = context.maps().managed_basemap_summary().await? {
        return Ok(Json(config_from_managed_summary(summary, &base_url)));
    }

    let Some(reader) = context.pmtiles_reader() else {
        return Ok(Json(BasemapConfigResponse {
            enabled: false,
            style_url: None,
            tile_type: None,
            min_zoom: None,
            max_zoom: None,
            bounds: None,
            message: Some("No PMTiles archive configured".to_owned()),
        }));
    };

    let header = reader.get_header();
    let tile_type = tile_type_name(header.tile_type);
    let style_url = match header.tile_type {
        pmtiles::TileType::Png
        | pmtiles::TileType::Jpeg
        | pmtiles::TileType::Webp
        | pmtiles::TileType::Avif => Some(absolute_url(&base_url, "/api/basemap/style.json")),
        pmtiles::TileType::Mvt | pmtiles::TileType::Mlt => context
            .config()
            .pmtiles_style_path
            .as_ref()
            .map(|_| absolute_url(&base_url, "/api/basemap/style.json")),
        pmtiles::TileType::Unknown => None,
    };

    let message = if style_url.is_none()
        && matches!(
            header.tile_type,
            pmtiles::TileType::Mvt | pmtiles::TileType::Mlt
        ) {
        Some(
            "PMTiles archive is vector data. Set MAP_TRAVEL_PMTILES_STYLE_PATH to render it as a basemap."
                .to_owned(),
        )
    } else {
        None
    };

    Ok(Json(BasemapConfigResponse {
        enabled: true,
        style_url,
        tile_type: Some(tile_type.to_owned()),
        min_zoom: Some(header.min_zoom),
        max_zoom: Some(header.max_zoom),
        bounds: Some([
            header.min_longitude,
            header.min_latitude,
            header.max_longitude,
            header.max_latitude,
        ]),
        message,
    }))
}

#[utoipa::path(
    get,
    path = "/api/basemap/style.json",
    responses(
        (status = 200, description = "MapLibre style JSON", content_type = "application/json"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_basemap_style(
    State(context): State<Arc<AppContext>>,
    headers: HeaderMap,
) -> AppResult<Json<serde_json::Value>> {
    let base_url = request_base_url(&headers);
    if let Some(style) = context.maps().managed_style().await? {
        return Ok(Json(absolutize_style_urls(style, &base_url)));
    }

    let reader = context
        .pmtiles_reader()
        .ok_or_else(|| AppError::InvalidRequest("No PMTiles archive configured".to_owned()))?;
    let header = reader.get_header();

    if let Some(style_path) = &context.config().pmtiles_style_path {
        let style = tokio::fs::read_to_string(style_path)
            .await
            .map_err(|error| AppError::Internal(format!("could not read style JSON: {error}")))?;
        let parsed = serde_json::from_str(&style)
            .map_err(|error| AppError::Internal(format!("style JSON was invalid: {error}")))?;
        return Ok(Json(absolutize_style_urls(parsed, &base_url)));
    }

    match header.tile_type {
        pmtiles::TileType::Png
        | pmtiles::TileType::Jpeg
        | pmtiles::TileType::Webp
        | pmtiles::TileType::Avif => Ok(Json(serde_json::json!({
            "version": 8,
            "sources": {
                "basemap": {
                    "type": "raster",
                    "tiles": [absolute_url(&base_url, "/api/basemap/tiles/{z}/{x}/{y}")],
                    "tileSize": 256,
                    "minzoom": header.min_zoom,
                    "maxzoom": header.max_zoom,
                }
            },
            "layers": [
                {
                    "id": "basemap",
                    "type": "raster",
                    "source": "basemap"
                }
            ]
        }))),
        pmtiles::TileType::Mvt | pmtiles::TileType::Mlt => Err(AppError::InvalidRequest(
            "Vector PMTiles archives require MAP_TRAVEL_PMTILES_STYLE_PATH".to_owned(),
        )),
        pmtiles::TileType::Unknown => Err(AppError::InvalidRequest(
            "PMTiles archive reported an unknown tile type".to_owned(),
        )),
    }
}

#[utoipa::path(
    get,
    path = "/api/basemap/tilejson.json",
    responses(
        (status = 200, description = "TileJSON document", content_type = "application/json"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_basemap_tilejson(
    State(context): State<Arc<AppContext>>,
    headers: HeaderMap,
) -> AppResult<Json<serde_json::Value>> {
    let tilejson = context
        .maps()
        .managed_tilejson()
        .await?
        .ok_or_else(|| AppError::InvalidRequest("No managed basemap is active".to_owned()))?;
    Ok(Json(absolutize_tilejson(
        tilejson,
        &request_base_url(&headers),
    )))
}

#[utoipa::path(
    get,
    path = "/api/basemap/fonts/{font_path}",
    params(("font_path" = String, Path, description = "Fontstack and glyph range path")),
    responses(
        (status = 200, description = "Glyph PBF", content_type = "application/x-protobuf"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_basemap_font(
    State(context): State<Arc<AppContext>>,
    Path(font_path): Path<String>,
) -> AppResult<impl axum::response::IntoResponse> {
    let normalized_path = font_path.trim_start_matches('/');
    let (fontstack, range_path) = normalized_path
        .rsplit_once('/')
        .ok_or_else(|| AppError::InvalidRequest("invalid managed font asset path".to_owned()))?;
    let range = range_path
        .strip_suffix(".pbf")
        .ok_or_else(|| AppError::InvalidRequest("invalid managed font asset path".to_owned()))?;
    let bytes = context
        .maps()
        .managed_font_bytes(fontstack, range)
        .await?
        .ok_or_else(|| AppError::InvalidRequest("No managed font asset is available".to_owned()))?;
    build_binary_response(bytes, "application/x-protobuf")
}

#[utoipa::path(
    get,
    path = "/api/basemap/sprite.json",
    responses(
        (status = 200, description = "Sprite JSON", content_type = "application/json"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_basemap_sprite_json(
    State(context): State<Arc<AppContext>>,
) -> AppResult<impl axum::response::IntoResponse> {
    let bytes = context
        .maps()
        .managed_sprite_json(false)
        .await?
        .ok_or_else(|| {
            AppError::InvalidRequest("No managed sprite asset is available".to_owned())
        })?;
    build_binary_response(bytes, "application/json")
}

#[utoipa::path(
    get,
    path = "/api/basemap/sprite.png",
    responses(
        (status = 200, description = "Sprite PNG", content_type = "image/png"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_basemap_sprite_png(
    State(context): State<Arc<AppContext>>,
) -> AppResult<impl axum::response::IntoResponse> {
    let bytes = context
        .maps()
        .managed_sprite_png(false)
        .await?
        .ok_or_else(|| {
            AppError::InvalidRequest("No managed sprite asset is available".to_owned())
        })?;
    build_binary_response(bytes, "image/png")
}

#[utoipa::path(
    get,
    path = "/api/basemap/sprite@2x.json",
    responses(
        (status = 200, description = "HiDPI sprite JSON", content_type = "application/json"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_basemap_sprite_json_hidpi(
    State(context): State<Arc<AppContext>>,
) -> AppResult<impl axum::response::IntoResponse> {
    let bytes = context
        .maps()
        .managed_sprite_json(true)
        .await?
        .ok_or_else(|| {
            AppError::InvalidRequest("No managed sprite asset is available".to_owned())
        })?;
    build_binary_response(bytes, "application/json")
}

#[utoipa::path(
    get,
    path = "/api/basemap/sprite@2x.png",
    responses(
        (status = 200, description = "HiDPI sprite PNG", content_type = "image/png"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_basemap_sprite_png_hidpi(
    State(context): State<Arc<AppContext>>,
) -> AppResult<impl axum::response::IntoResponse> {
    let bytes = context
        .maps()
        .managed_sprite_png(true)
        .await?
        .ok_or_else(|| {
            AppError::InvalidRequest("No managed sprite asset is available".to_owned())
        })?;
    build_binary_response(bytes, "image/png")
}

#[utoipa::path(
    get,
    path = "/api/basemap/tiles/{z}/{x}/{y}",
    params(
        ("z" = u8, Path, description = "Tile zoom"),
        ("x" = u32, Path, description = "Tile X coordinate"),
        ("y" = u32, Path, description = "Tile Y coordinate")
    ),
    responses(
        (status = 200, description = "Map tile", content_type = "application/octet-stream"),
        (status = 204, description = "Tile coordinate has no tile data"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_basemap_tile(
    State(context): State<Arc<AppContext>>,
    Path((z, x, y)): Path<(u8, u32, u32)>,
) -> AppResult<axum::response::Response> {
    let coord = pmtiles::TileCoord::new(z, x, y)
        .map_err(|error| AppError::InvalidRequest(format!("invalid tile coordinate: {error}")))?;

    if let Some(tile) = load_basemap_tile(&context, coord).await? {
        return build_tile_response(tile.bytes, tile.tile_type, tile.tile_compression);
    }

    build_empty_tile_response()
}

#[utoipa::path(
    get,
    path = "/api/basemap/missing-tiles",
    params(MissingTilesQuery),
    responses(
        (status = 200, description = "Missing basemap tile recommendation", body = MissingTilesResponse),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
pub(crate) async fn get_missing_basemap_tiles(
    State(context): State<Arc<AppContext>>,
    Query(query): Query<MissingTilesQuery>,
) -> AppResult<Json<MissingTilesResponse>> {
    validate_bbox(query.min_lon, query.min_lat, query.max_lon, query.max_lat)?;
    if query.tile_zoom > MAX_MISSING_TILE_ZOOM {
        return Err(AppError::InvalidRequest(format!(
            "tile_zoom must be at most {MAX_MISSING_TILE_ZOOM}"
        )));
    }

    let (min_x, max_x, min_y, max_y) = tile_range_for_bbox(
        query.min_lon,
        query.min_lat,
        query.max_lon,
        query.max_lat,
        query.tile_zoom,
    );
    let x_count = max_x
        .checked_sub(min_x)
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| AppError::Internal("invalid x tile range".to_owned()))?;
    let y_count = max_y
        .checked_sub(min_y)
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| AppError::Internal("invalid y tile range".to_owned()))?;
    let scan_count = x_count
        .checked_mul(y_count)
        .ok_or_else(|| AppError::InvalidRequest("tile scan is too large".to_owned()))?;
    if scan_count > MAX_MISSING_TILE_SCAN {
        return Err(AppError::InvalidRequest(format!(
            "tile scan is too large; narrow the viewport or lower zoom below {scan_count} tiles"
        )));
    }

    let mut missing_tile_count = 0_u32;
    let mut missing_bounds: Option<[f64; 4]> = None;
    for x in min_x..=max_x {
        for y in min_y..=max_y {
            let coord = pmtiles::TileCoord::new(query.tile_zoom, x, y).map_err(|error| {
                AppError::Internal(format!("invalid generated tile coordinate: {error}"))
            })?;
            if load_basemap_tile(&context, coord).await?.is_none() {
                missing_tile_count = missing_tile_count.checked_add(1).ok_or_else(|| {
                    AppError::Internal("missing tile count overflowed".to_owned())
                })?;
                missing_bounds = Some(expand_bounds(missing_bounds, tile_bounds_for_coord(coord)));
            }
        }
    }

    Ok(Json(MissingTilesResponse {
        missing: missing_tile_count > 0,
        tile_zoom: query.tile_zoom,
        missing_tile_count,
        bounds: missing_bounds,
        max_zoom: (missing_tile_count > 0).then_some(query.tile_zoom),
    }))
}

fn config_from_managed_summary(
    summary: ManagedBasemapSummary,
    base_url: &str,
) -> BasemapConfigResponse {
    BasemapConfigResponse {
        enabled: true,
        style_url: Some(absolute_url(base_url, "/api/basemap/style.json")),
        tile_type: Some(tile_type_name(summary.tile_type).to_owned()),
        min_zoom: Some(summary.min_zoom),
        max_zoom: Some(summary.max_zoom),
        bounds: Some(summary.bounds),
        message: summary.message,
    }
}

fn request_base_url(headers: &HeaderMap) -> String {
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or("http");
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1:3000");
    format!("{proto}://{host}")
}

fn absolute_url(base_url: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        path.to_owned()
    } else {
        format!("{base_url}{path}")
    }
}

fn absolutize_style_urls(mut style: serde_json::Value, base_url: &str) -> serde_json::Value {
    if let Some(style_object) = style.as_object_mut() {
        if let Some(sprite) = style_object
            .get("sprite")
            .and_then(serde_json::Value::as_str)
            .map(|value| absolute_url(base_url, value))
        {
            style_object.insert("sprite".to_owned(), serde_json::Value::String(sprite));
        }
        if let Some(glyphs) = style_object
            .get("glyphs")
            .and_then(serde_json::Value::as_str)
            .map(|value| absolute_url(base_url, value))
        {
            style_object.insert("glyphs".to_owned(), serde_json::Value::String(glyphs));
        }
    }
    if let Some(sources) = style
        .get_mut("sources")
        .and_then(serde_json::Value::as_object_mut)
    {
        for source in sources.values_mut() {
            if let Some(source_object) = source.as_object_mut()
                && let Some(url) = source_object
                    .get("url")
                    .and_then(serde_json::Value::as_str)
                    .map(|value| absolute_url(base_url, value))
            {
                source_object.insert("url".to_owned(), serde_json::Value::String(url));
            }
            if let Some(tiles) = source
                .get_mut("tiles")
                .and_then(serde_json::Value::as_array_mut)
            {
                for tile in tiles.iter_mut() {
                    if let Some(url) = tile.as_str() {
                        *tile = serde_json::Value::String(absolute_url(base_url, url));
                    }
                }
            }
        }
    }
    style
}

fn absolutize_tilejson(mut tilejson: serde_json::Value, base_url: &str) -> serde_json::Value {
    if let Some(tiles) = tilejson
        .get_mut("tiles")
        .and_then(serde_json::Value::as_array_mut)
    {
        for tile in tiles.iter_mut() {
            if let Some(url) = tile.as_str() {
                *tile = serde_json::Value::String(absolute_url(base_url, url));
            }
        }
    }
    tilejson
}

fn build_tile_response(
    tile: bytes::Bytes,
    tile_type: pmtiles::TileType,
    tile_compression: pmtiles::Compression,
) -> AppResult<axum::response::Response> {
    let mut response = axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, tile_type.content_type());

    if let Some(content_encoding) = tile_compression.content_encoding() {
        response = response.header(axum::http::header::CONTENT_ENCODING, content_encoding);
    }

    response
        .body(axum::body::Body::from(tile))
        .map_err(|error| AppError::Internal(format!("could not build tile response: {error}")))
}

struct LoadedBasemapTile {
    bytes: bytes::Bytes,
    tile_type: pmtiles::TileType,
    tile_compression: pmtiles::Compression,
}

async fn load_basemap_tile(
    context: &AppContext,
    coord: pmtiles::TileCoord,
) -> AppResult<Option<LoadedBasemapTile>> {
    if let Some(tile) = context.maps().managed_tile(coord).await? {
        return Ok(Some(LoadedBasemapTile {
            bytes: tile.bytes,
            tile_type: tile.tile_type,
            tile_compression: tile.tile_compression,
        }));
    }

    let Some(reader) = context.pmtiles_reader() else {
        return Ok(None);
    };
    let header = reader.get_header();
    let Some(bytes) = reader
        .get_tile(coord)
        .await
        .map_err(|error| AppError::Internal(format!("could not read PMTiles tile: {error}")))?
    else {
        return Ok(None);
    };

    Ok(Some(LoadedBasemapTile {
        bytes,
        tile_type: header.tile_type,
        tile_compression: header.tile_compression,
    }))
}

fn build_empty_tile_response() -> AppResult<axum::response::Response> {
    axum::response::Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .map_err(|error| {
            AppError::Internal(format!("could not build empty tile response: {error}"))
        })
}

fn expand_bounds(existing: Option<[f64; 4]>, next: [f64; 4]) -> [f64; 4] {
    match existing {
        Some(current) => {
            let [
                current_min_lon,
                current_min_lat,
                current_max_lon,
                current_max_lat,
            ] = current;
            let [next_min_lon, next_min_lat, next_max_lon, next_max_lat] = next;
            [
                current_min_lon.min(next_min_lon),
                current_min_lat.min(next_min_lat),
                current_max_lon.max(next_max_lon),
                current_max_lat.max(next_max_lat),
            ]
        }
        None => next,
    }
}

fn build_binary_response(
    body: bytes::Bytes,
    content_type: &'static str,
) -> AppResult<axum::response::Response> {
    axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, content_type)
        .body(axum::body::Body::from(body))
        .map_err(|error| AppError::Internal(format!("could not build asset response: {error}")))
}

fn tile_type_name(tile_type: pmtiles::TileType) -> &'static str {
    match tile_type {
        pmtiles::TileType::Unknown => "unknown",
        pmtiles::TileType::Mvt => "mvt",
        pmtiles::TileType::Png => "png",
        pmtiles::TileType::Jpeg => "jpeg",
        pmtiles::TileType::Webp => "webp",
        pmtiles::TileType::Avif => "avif",
        pmtiles::TileType::Mlt => "mlt",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::absolutize_style_urls;

    #[test]
    fn absolutize_style_urls_rewrites_relative_assets() {
        let style = json!({
            "sprite": "/api/basemap/sprite",
            "glyphs": "/api/basemap/fonts/{fontstack}/{range}.pbf",
            "sources": {
                "basemap": {
                    "url": "/api/basemap/tilejson.json",
                    "tiles": ["/api/basemap/tiles/{z}/{x}/{y}"]
                }
            }
        });

        let rewritten = absolutize_style_urls(style, "http://maps.test");

        assert_eq!(
            rewritten.get("sprite").and_then(serde_json::Value::as_str),
            Some("http://maps.test/api/basemap/sprite")
        );
        assert_eq!(
            rewritten.get("glyphs").and_then(serde_json::Value::as_str),
            Some("http://maps.test/api/basemap/fonts/{fontstack}/{range}.pbf")
        );
        assert_eq!(
            rewritten["sources"]["basemap"]["url"].as_str(),
            Some("http://maps.test/api/basemap/tilejson.json")
        );
        assert_eq!(
            rewritten["sources"]["basemap"]["tiles"][0].as_str(),
            Some("http://maps.test/api/basemap/tiles/{z}/{x}/{y}")
        );
    }
}
