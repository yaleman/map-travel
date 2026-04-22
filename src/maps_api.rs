use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::Deserialize;

use crate::{
    app::AppContext,
    error::{AppError, AppResult},
    maps::{ActiveLayerUpdate, ManagedBasemapSummary},
};

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
        .route("/api/basemap/tilejson.json", get(get_basemap_tilejson))
        .route("/api/basemap/tiles/{z}/{x}/{y}", get(get_basemap_tile))
}

#[derive(Debug, Deserialize)]
struct WorldTo6Request {
    build_key: String,
}

#[derive(Debug, Deserialize)]
struct AreaExtractRequest {
    build_key: String,
    label: String,
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
    max_zoom: i32,
}

#[derive(Debug, Deserialize)]
struct ActiveLayersRequest {
    selected_build_key: String,
    layers: Vec<ActiveLayerUpdate>,
}

#[derive(Debug, Deserialize)]
struct RebuildChunksRequest {
    build_key: String,
    chunk_ids: Option<Vec<String>>,
}

#[derive(Debug, serde::Serialize)]
struct BasemapConfigResponse {
    enabled: bool,
    style_url: Option<String>,
    tile_type: Option<String>,
    min_zoom: Option<u8>,
    max_zoom: Option<u8>,
    bounds: Option<[f64; 4]>,
    message: Option<String>,
}

async fn get_builds(State(context): State<Arc<AppContext>>) -> AppResult<Json<serde_json::Value>> {
    let payload = context.maps().fetch_build_catalog().await?;
    serde_json::to_value(payload)
        .map(Json)
        .map_err(|error| AppError::Internal(format!("could not serialize build catalog: {error}")))
}

async fn get_local_maps(
    State(context): State<Arc<AppContext>>,
) -> AppResult<Json<serde_json::Value>> {
    let payload = context.maps().list_local_maps().await?;
    serde_json::to_value(payload)
        .map(Json)
        .map_err(|error| AppError::Internal(format!("could not serialize local maps: {error}")))
}

async fn get_jobs(State(context): State<Arc<AppContext>>) -> AppResult<Json<serde_json::Value>> {
    let payload = context.maps().list_jobs().await?;
    serde_json::to_value(payload)
        .map(Json)
        .map_err(|error| AppError::Internal(format!("could not serialize map jobs: {error}")))
}

async fn post_cancel_job(
    State(context): State<Arc<AppContext>>,
    Path(job_id): Path<String>,
) -> AppResult<StatusCode> {
    context.maps().cancel_job(&job_id).await?;
    Ok(StatusCode::OK)
}

async fn post_world_to_6(
    State(context): State<Arc<AppContext>>,
    Json(request): Json<WorldTo6Request>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    let payload = context.maps().queue_world_to_6(&request.build_key).await?;
    let json = serde_json::to_value(payload).map_err(|error| {
        AppError::Internal(format!("could not serialize world-to-6 response: {error}"))
    })?;
    Ok((StatusCode::CREATED, Json(json)))
}

async fn post_area_extract(
    State(context): State<Arc<AppContext>>,
    Json(request): Json<AreaExtractRequest>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    let payload = context
        .maps()
        .queue_area_extract(
            request.label,
            &request.build_key,
            request.min_lon,
            request.min_lat,
            request.max_lon,
            request.max_lat,
            request.max_zoom,
        )
        .await?;
    let json = serde_json::to_value(payload).map_err(|error| {
        AppError::Internal(format!(
            "could not serialize area extract response: {error}"
        ))
    })?;
    Ok((StatusCode::CREATED, Json(json)))
}

async fn post_active_layers(
    State(context): State<Arc<AppContext>>,
    Json(request): Json<ActiveLayersRequest>,
) -> AppResult<StatusCode> {
    context
        .maps()
        .update_active_layers(&request.selected_build_key, &request.layers)
        .await?;
    Ok(StatusCode::OK)
}

async fn post_rebuild_chunks(
    State(context): State<Arc<AppContext>>,
    Json(request): Json<RebuildChunksRequest>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    let payload = context
        .maps()
        .rebuild_chunks(&request.build_key, request.chunk_ids)
        .await?;
    let json = serde_json::to_value(payload).map_err(|error| {
        AppError::Internal(format!("could not serialize rebuild response: {error}"))
    })?;
    Ok((StatusCode::CREATED, Json(json)))
}

async fn get_basemap_config(
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

async fn get_basemap_style(
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

async fn get_basemap_tilejson(
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

async fn get_basemap_tile(
    State(context): State<Arc<AppContext>>,
    Path((z, x, y)): Path<(u8, u32, u32)>,
) -> AppResult<impl axum::response::IntoResponse> {
    let coord = pmtiles::TileCoord::new(z, x, y)
        .map_err(|error| AppError::InvalidRequest(format!("invalid tile coordinate: {error}")))?;

    if let Some(tile) = context.maps().managed_tile(coord).await? {
        return build_tile_response(tile.bytes, tile.tile_type, tile.tile_compression);
    }

    let reader = context
        .pmtiles_reader()
        .ok_or_else(|| AppError::InvalidRequest("No PMTiles archive configured".to_owned()))?;
    let header = reader.get_header();
    let tile = reader
        .get_tile(coord)
        .await
        .map_err(|error| AppError::Internal(format!("could not read PMTiles tile: {error}")))?
        .ok_or_else(|| AppError::InvalidRequest("tile not found in PMTiles archive".to_owned()))?;

    build_tile_response(tile, header.tile_type, header.tile_compression)
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
        .unwrap_or("127.0.0.1:9000");
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
    if let Some(sprite) = style.get("sprite").and_then(serde_json::Value::as_str) {
        let absolute = absolute_url(base_url, sprite);
        style["sprite"] = serde_json::Value::String(absolute);
    }
    if let Some(glyphs) = style.get("glyphs").and_then(serde_json::Value::as_str) {
        let absolute = absolute_url(base_url, glyphs);
        style["glyphs"] = serde_json::Value::String(absolute);
    }
    if let Some(sources) = style
        .get_mut("sources")
        .and_then(serde_json::Value::as_object_mut)
    {
        for source in sources.values_mut() {
            if let Some(url) = source.get("url").and_then(serde_json::Value::as_str) {
                let absolute = absolute_url(base_url, url);
                source["url"] = serde_json::Value::String(absolute);
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
