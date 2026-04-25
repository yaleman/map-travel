use std::{collections::HashMap, path::Path, sync::Arc};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{
        HeaderMap, HeaderValue, Request, Response, StatusCode,
        header::{CONTENT_LENGTH, CONTENT_RANGE, ETAG, RANGE},
    },
    routing::get,
};
use chrono::Utc;
use http_body_util::BodyExt;
use pmtiles::{PmTilesWriter, TileCoord, TileType};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{net::TcpListener, sync::oneshot};
use tower::util::ServiceExt;

use map_travel::{AppConfig, AppContext, build_router};

#[derive(Clone)]
struct MockBuild {
    key: String,
    bytes: Arc<Vec<u8>>,
}

#[derive(Clone)]
struct MockServerState {
    builds_json: Value,
    files: Arc<HashMap<String, Arc<Vec<u8>>>>,
    delay_ms: u64,
}

async fn json_response(response: axum::response::Response) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body should collect")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("response should be valid JSON")
}

async fn bytes_response(response: axum::response::Response) -> Vec<u8> {
    response
        .into_body()
        .collect()
        .await
        .expect("response body should collect")
        .to_bytes()
        .to_vec()
}

async fn builds_handler(State(state): State<Arc<MockServerState>>) -> Json<Value> {
    Json(state.builds_json.clone())
}

async fn pmtiles_handler(
    State(state): State<Arc<MockServerState>>,
    AxumPath(key): AxumPath<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let Some(bytes) = state.files.get(&key) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .expect("404 response should build");
    };

    let range_header = headers
        .get(RANGE)
        .and_then(|value| value.to_str().ok())
        .expect("range header should exist");
    let range = range_header
        .strip_prefix("bytes=")
        .expect("range should start with bytes=");
    let (start, end) = range.split_once('-').expect("range should contain hyphen");
    let start = start.parse::<usize>().expect("range start should parse");
    let end = end.parse::<usize>().expect("range end should parse");
    let slice = &bytes[start..=end];

    if state.delay_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(state.delay_ms)).await;
    }

    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(CONTENT_LENGTH, HeaderValue::from(slice.len()))
        .header(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{}", bytes.len()))
                .expect("content-range should parse"),
        )
        .header(ETAG, HeaderValue::from_static("\"mock-etag\""))
        .body(Body::from(slice.to_vec()))
        .expect("partial response should build")
}

async fn spawn_mock_server(
    builds: Vec<MockBuild>,
) -> (String, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    spawn_mock_server_with_delay(builds, 0).await
}

async fn spawn_mock_server_with_delay(
    builds: Vec<MockBuild>,
    delay_ms: u64,
) -> (String, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let builds_json = Value::Array(
        builds
            .iter()
            .map(|build| {
                json!({
                    "key": build.key,
                    "size": build.bytes.len(),
                    "uploaded": "2026-04-21T08:44:44.550Z",
                    "version": "4.14.5"
                })
            })
            .collect(),
    );
    let files = builds
        .into_iter()
        .map(|build| (build.key, build.bytes))
        .collect::<HashMap<_, _>>();
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener should bind");
    let addr = listener
        .local_addr()
        .expect("listener should have local addr");
    let base_url = format!("http://{addr}");
    let state = Arc::new(MockServerState {
        builds_json,
        files: Arc::new(files),
        delay_ms,
    });
    let router = Router::new()
        .route("/builds.json", get(builds_handler))
        .route("/{key}", get(pmtiles_handler))
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("mock server should run");
    });

    (base_url, shutdown_tx, handle)
}

fn tile_bounds(z: u8, x: u32, y: u32) -> (f64, f64, f64, f64) {
    let tiles = f64::from(1_u32 << z);
    let min_lon = f64::from(x) / tiles * 360.0 - 180.0;
    let max_lon = f64::from(x + 1) / tiles * 360.0 - 180.0;
    let min_lat = tile_y_to_lat(y + 1, z);
    let max_lat = tile_y_to_lat(y, z);
    (min_lon, min_lat, max_lon, max_lat)
}

fn tile_y_to_lat(y: u32, z: u8) -> f64 {
    let tiles = f64::from(1_u32 << z);
    let n = std::f64::consts::PI - (2.0 * std::f64::consts::PI * f64::from(y) / tiles);
    n.sinh().atan().to_degrees()
}

fn build_inner_bbox(z: u8, x: u32, y: u32) -> (f64, f64, f64, f64) {
    let (min_lon, min_lat, max_lon, max_lat) = tile_bounds(z, x, y);
    let lon_pad = (max_lon - min_lon) * 0.1;
    let lat_pad = (max_lat - min_lat) * 0.1;
    (
        min_lon + lon_pad,
        min_lat + lat_pad,
        max_lon - lon_pad,
        max_lat - lat_pad,
    )
}

fn create_source_pmtiles(path: &Path, region_tile: &[u8], coarse_tile: &[u8]) -> Vec<u8> {
    let file = std::fs::File::create(path).expect("source file should be created");
    let mut writer = PmTilesWriter::new(TileType::Mvt)
        .min_zoom(0)
        .max_zoom(6)
        .bounds(-180.0, -85.051_129, 180.0, 85.051_129)
        .center(0.0, 0.0)
        .center_zoom(1)
        .metadata("{\"name\":\"mock build\"}")
        .create(file)
        .expect("pmtiles writer should be created");
    writer
        .add_raw_tile(
            TileCoord::new(0, 0, 0).expect("world coord should be valid"),
            b"world",
        )
        .expect("world tile should be written");
    writer
        .add_raw_tile(
            TileCoord::new(2, 0, 0).expect("coarse coord should be valid"),
            coarse_tile,
        )
        .expect("coarse tile should be written");
    writer
        .add_raw_tile(
            TileCoord::new(2, 2, 1).expect("region coord should be valid"),
            region_tile,
        )
        .expect("region tile should be written");
    writer.finalize().expect("pmtiles writer should finalize");
    std::fs::read(path).expect("pmtiles file should be readable")
}

fn app_config(temp_dir: &TempDir, base_url: &str) -> AppConfig {
    create_vendored_basemap_assets(&temp_dir.path().join("vendored-basemap"));
    AppConfig {
        database_url: format!(
            "sqlite:{}?mode=rwc",
            temp_dir.path().join("map-travel.sqlite").display()
        ),
        listen_addr: "127.0.0.1:0".parse().expect("listen addr should parse"),
        pmtiles_path: None,
        pmtiles_style_path: None,
        vendored_basemap_dir: temp_dir.path().join("vendored-basemap"),
        managed_maps_dir: Some(temp_dir.path().join("managed-maps")),
        protomaps_builds_metadata_url: format!("{base_url}/builds.json"),
        protomaps_builds_base_url: base_url.to_owned(),
    }
}

fn create_vendored_basemap_assets(base_dir: &Path) {
    std::fs::create_dir_all(base_dir.join("fonts").join("Noto Sans Italic"))
        .expect("font dir should be created");
    std::fs::write(
        base_dir.join("style.json"),
        serde_json::json!({
            "version": 8,
            "sprite": "https://example.invalid/assets/sprites/light",
            "glyphs": "https://example.invalid/assets/fonts/{fontstack}/{range}.pbf",
            "sources": {
                "protomaps": {
                    "type": "vector",
                    "url": "https://example.invalid/tiles.json"
                }
            },
            "layers": []
        })
        .to_string(),
    )
    .expect("style should be written");
    std::fs::write(base_dir.join("sprite.json"), br#"{"test":"sprite"}"#)
        .expect("sprite json should be written");
    std::fs::write(base_dir.join("sprite.png"), [1, 2, 3, 4])
        .expect("sprite png should be written");
    std::fs::write(base_dir.join("sprite@2x.json"), br#"{"test":"sprite-2x"}"#)
        .expect("hidpi sprite json should be written");
    std::fs::write(base_dir.join("sprite@2x.png"), [4, 3, 2, 1])
        .expect("hidpi sprite png should be written");
    std::fs::write(
        base_dir
            .join("fonts")
            .join("Noto Sans Italic")
            .join("0-255.pbf"),
        b"glyphs",
    )
    .expect("font range should be written");
}

async fn wait_for_all_jobs(router: &Router) {
    for _ in 0..100 {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/settings/maps/jobs")
                    .body(Body::empty())
                    .expect("jobs request should build"),
            )
            .await
            .expect("jobs request should succeed");
        let payload = json_response(response).await;
        let jobs = payload["jobs"].as_array().expect("jobs should be an array");
        if jobs.iter().all(|job| {
            matches!(
                job["status"].as_str(),
                Some("completed" | "failed" | "cancelled")
            )
        }) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    panic!("jobs did not complete in time");
}

async fn post_json(router: &Router, uri: &str, body: Value) -> axum::response::Response {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", mime::APPLICATION_JSON.as_ref())
                .body(Body::from(body.to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should succeed")
}

#[tokio::test]
async fn caches_build_catalog_after_the_upstream_source_goes_away() {
    let temp_dir = TempDir::new().expect("temp dir should be created");
    let build_path = temp_dir.path().join("catalog-source.pmtiles");
    let build_bytes = create_source_pmtiles(&build_path, b"region-a", b"coarse-a");
    let (base_url, shutdown_tx, handle) = spawn_mock_server(vec![MockBuild {
        key: "20260421.pmtiles".to_owned(),
        bytes: Arc::new(build_bytes),
    }])
    .await;

    let context = Arc::new(
        AppContext::bootstrap(app_config(&temp_dir, &base_url))
            .await
            .expect("bootstrap should succeed"),
    );
    let router = build_router(context);

    let first_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/builds")
                .body(Body::empty())
                .expect("builds request should build"),
        )
        .await
        .expect("builds request should succeed");
    assert_eq!(first_response.status(), StatusCode::OK);
    let first_payload = json_response(first_response).await;
    assert_eq!(
        first_payload["builds"]
            .as_array()
            .expect("builds should be an array")
            .len(),
        1
    );

    shutdown_tx.send(()).expect("mock server should shut down");
    handle.await.expect("mock server task should finish");

    let second_response = router
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/builds")
                .body(Body::empty())
                .expect("builds request should build"),
        )
        .await
        .expect("cached builds request should succeed");
    assert_eq!(second_response.status(), StatusCode::OK);
    let second_payload = json_response(second_response).await;
    assert_eq!(
        second_payload["builds"][0]["key"]
            .as_str()
            .expect("cached build key should exist"),
        "20260421.pmtiles"
    );
}

#[tokio::test]
async fn materializes_world_and_area_chunks_then_rebuilds_them_for_a_new_selected_build() {
    let temp_dir = TempDir::new().expect("temp dir should be created");
    let build_a_path = temp_dir.path().join("20260420.pmtiles");
    let build_b_path = temp_dir.path().join("20260421.pmtiles");
    let build_a = create_source_pmtiles(&build_a_path, b"region-a", b"coarse-a");
    let build_b = create_source_pmtiles(&build_b_path, b"region-b", b"coarse-b");

    let (base_url, shutdown_tx, handle) = spawn_mock_server(vec![
        MockBuild {
            key: "20260420.pmtiles".to_owned(),
            bytes: Arc::new(build_a),
        },
        MockBuild {
            key: "20260421.pmtiles".to_owned(),
            bytes: Arc::new(build_b),
        },
    ])
    .await;

    let context = Arc::new(
        AppContext::bootstrap(app_config(&temp_dir, &base_url))
            .await
            .expect("bootstrap should succeed"),
    );
    let router = build_router(context);

    let world_response = post_json(
        &router,
        "/api/settings/maps/world-to-6",
        json!({ "build_key": "20260420.pmtiles" }),
    )
    .await;
    assert_eq!(world_response.status(), StatusCode::CREATED);
    let world_payload = json_response(world_response).await;
    let world_chunk_id = world_payload["chunk_id"]
        .as_str()
        .expect("world chunk id should exist")
        .to_owned();

    let (min_lon, min_lat, max_lon, max_lat) = build_inner_bbox(2, 2, 1);
    let area_response = post_json(
        &router,
        "/api/settings/maps/area-extract",
        json!({
            "build_key": "20260420.pmtiles",
            "label": "Regional detail",
            "min_lon": min_lon,
            "min_lat": min_lat,
            "max_lon": max_lon,
            "max_lat": max_lat,
            "max_zoom": 2
        }),
    )
    .await;
    assert_eq!(area_response.status(), StatusCode::CREATED);
    let area_payload = json_response(area_response).await;
    let area_chunk_id = area_payload["chunk_id"]
        .as_str()
        .expect("area chunk id should exist")
        .to_owned();

    wait_for_all_jobs(&router).await;

    let local_before_activation = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/local")
                .body(Body::empty())
                .expect("local maps request should build"),
        )
        .await
        .expect("local maps request should succeed");
    let local_before_activation_payload = json_response(local_before_activation).await;
    assert_eq!(
        local_before_activation_payload["chunks"]
            .as_array()
            .expect("chunks should be an array")
            .len(),
        2
    );
    assert!(
        local_before_activation_payload["chunks"]
            .as_array()
            .expect("chunks should be an array")
            .iter()
            .all(|chunk| chunk["latest_job"].is_object())
    );

    let jobs_after_initial_download = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/jobs")
                .body(Body::empty())
                .expect("jobs request should build"),
        )
        .await
        .expect("jobs request should succeed");
    let jobs_after_initial_download_payload = json_response(jobs_after_initial_download).await;
    assert!(
        jobs_after_initial_download_payload["jobs"]
            .as_array()
            .expect("jobs should be an array")
            .is_empty(),
        "completed jobs should be hidden from the jobs list"
    );

    let active_layers_response = post_json(
        &router,
        "/api/settings/maps/active-layers",
        json!({
            "selected_build_key": "20260420.pmtiles",
            "layers": [
                {
                    "chunk_id": world_chunk_id,
                    "enabled": true,
                    "display_order": 10
                },
                {
                    "chunk_id": area_chunk_id,
                    "enabled": true,
                    "display_order": 1
                }
            ]
        }),
    )
    .await;
    assert_eq!(active_layers_response.status(), StatusCode::OK);

    let basemap_config_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/basemap")
                .header("host", "maps.test")
                .body(Body::empty())
                .expect("basemap request should build"),
        )
        .await
        .expect("basemap request should succeed");
    let basemap_config_payload = json_response(basemap_config_response).await;
    assert_eq!(
        basemap_config_payload["style_url"].as_str(),
        Some("http://maps.test/api/basemap/style.json")
    );

    let style_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/basemap/style.json")
                .header("host", "maps.test")
                .body(Body::empty())
                .expect("style request should build"),
        )
        .await
        .expect("style request should succeed");
    assert_eq!(style_response.status(), StatusCode::OK);
    let style_payload = json_response(style_response).await;
    assert_eq!(
        style_payload["sprite"].as_str(),
        Some("http://maps.test/api/basemap/sprite")
    );
    assert_eq!(
        style_payload["glyphs"].as_str(),
        Some("http://maps.test/api/basemap/fonts/{fontstack}/{range}.pbf")
    );
    assert_eq!(
        style_payload["sources"]["protomaps"]["tiles"][0].as_str(),
        Some("http://maps.test/api/basemap/tiles/{z}/{x}/{y}")
    );
    assert_eq!(style_payload["sources"]["protomaps"]["maxzoom"], 6);

    let tilejson_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/basemap/tilejson.json")
                .header("host", "maps.test")
                .body(Body::empty())
                .expect("tilejson request should build"),
        )
        .await
        .expect("tilejson request should succeed");
    let tilejson_payload = json_response(tilejson_response).await;
    assert_eq!(
        tilejson_payload["tiles"][0].as_str(),
        Some("http://maps.test/api/basemap/tiles/{z}/{x}/{y}")
    );

    let sprite_json_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/basemap/sprite.json")
                .body(Body::empty())
                .expect("sprite request should build"),
        )
        .await
        .expect("sprite request should succeed");
    assert_eq!(sprite_json_response.status(), StatusCode::OK);
    assert_eq!(
        bytes_response(sprite_json_response).await,
        br#"{"test":"sprite"}"#
    );

    let font_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/basemap/fonts/Noto%20Sans%20Italic/0-255.pbf")
                .body(Body::empty())
                .expect("font request should build"),
        )
        .await
        .expect("font request should succeed");
    assert_eq!(font_response.status(), StatusCode::OK);
    assert_eq!(bytes_response(font_response).await, b"glyphs");

    let region_tile_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/basemap/tiles/2/2/1")
                .body(Body::empty())
                .expect("tile request should build"),
        )
        .await
        .expect("tile request should succeed");
    assert_eq!(region_tile_response.status(), StatusCode::OK);
    assert_eq!(bytes_response(region_tile_response).await, b"region-a");

    let fallback_tile_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/basemap/tiles/2/0/0")
                .body(Body::empty())
                .expect("tile request should build"),
        )
        .await
        .expect("tile request should succeed");
    assert_eq!(fallback_tile_response.status(), StatusCode::OK);
    assert_eq!(bytes_response(fallback_tile_response).await, b"coarse-a");

    let missing_tile_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/basemap/tiles/2/3/1")
                .body(Body::empty())
                .expect("missing tile request should build"),
        )
        .await
        .expect("missing tile request should succeed");
    assert_eq!(missing_tile_response.status(), StatusCode::NO_CONTENT);
    assert!(bytes_response(missing_tile_response).await.is_empty());

    let (missing_min_lon, missing_min_lat, missing_max_lon, missing_max_lat) =
        build_inner_bbox(2, 3, 1);
    let missing_coverage_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/basemap/missing-tiles?min_lon={missing_min_lon}&min_lat={missing_min_lat}&max_lon={missing_max_lon}&max_lat={missing_max_lat}&tile_zoom=2"
                ))
                .body(Body::empty())
                .expect("missing coverage request should build"),
        )
        .await
        .expect("missing coverage request should succeed");
    assert_eq!(missing_coverage_response.status(), StatusCode::OK);
    let missing_coverage_payload = json_response(missing_coverage_response).await;
    assert_eq!(missing_coverage_payload["missing"], true);
    assert_eq!(missing_coverage_payload["tile_zoom"], 2);
    assert_eq!(missing_coverage_payload["missing_tile_count"], 1);
    assert_eq!(missing_coverage_payload["max_zoom"], 2);
    assert_eq!(
        missing_coverage_payload["bounds"],
        json!([90.0, 0.0, 180.0, 66.51326044311186])
    );

    let (covered_min_lon, covered_min_lat, covered_max_lon, covered_max_lat) =
        build_inner_bbox(2, 2, 1);
    let covered_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/basemap/missing-tiles?min_lon={covered_min_lon}&min_lat={covered_min_lat}&max_lon={covered_max_lon}&max_lat={covered_max_lat}&tile_zoom=2"
                ))
                .body(Body::empty())
                .expect("covered tile request should build"),
        )
        .await
        .expect("covered tile request should succeed");
    assert_eq!(covered_response.status(), StatusCode::OK);
    let covered_payload = json_response(covered_response).await;
    assert_eq!(covered_payload["missing"], false);
    assert_eq!(covered_payload["missing_tile_count"], 0);
    assert!(covered_payload["bounds"].is_null());
    assert!(covered_payload["max_zoom"].is_null());

    let switch_build_response = post_json(
        &router,
        "/api/settings/maps/active-layers",
        json!({
            "selected_build_key": "20260421.pmtiles",
            "layers": [
                {
                    "chunk_id": world_chunk_id,
                    "enabled": true,
                    "display_order": 10
                },
                {
                    "chunk_id": area_chunk_id,
                    "enabled": true,
                    "display_order": 1
                }
            ]
        }),
    )
    .await;
    assert_eq!(switch_build_response.status(), StatusCode::OK);

    let local_after_switch = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/local")
                .body(Body::empty())
                .expect("local maps request should build"),
        )
        .await
        .expect("local maps request should succeed");
    let local_after_switch_payload = json_response(local_after_switch).await;
    let chunks = local_after_switch_payload["chunks"]
        .as_array()
        .expect("chunks should be an array");
    assert!(
        chunks
            .iter()
            .all(|chunk| chunk["stale"].as_bool().expect("stale flag should exist"))
    );

    let rebuild_response = post_json(
        &router,
        "/api/settings/maps/rebuild-chunks",
        json!({ "build_key": "20260421.pmtiles" }),
    )
    .await;
    assert_eq!(rebuild_response.status(), StatusCode::CREATED);
    wait_for_all_jobs(&router).await;

    let local_after_rebuild = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/local")
                .body(Body::empty())
                .expect("local maps request should build"),
        )
        .await
        .expect("local maps request should succeed");
    let local_after_rebuild_payload = json_response(local_after_rebuild).await;
    let rebuilt_chunks = local_after_rebuild_payload["chunks"]
        .as_array()
        .expect("chunks should be an array");
    assert!(rebuilt_chunks.iter().all(|chunk| {
        !chunk["stale"]
            .as_bool()
            .expect("stale flag should exist after rebuild")
    }));
    assert!(rebuilt_chunks.iter().all(|chunk| {
        chunk["selected_build_ready"].as_bool() == Some(true)
            && chunk["latest_job"]["progress_percent"].as_i64() == Some(100)
    }));

    let rebuilt_region_tile_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/basemap/tiles/2/2/1")
                .body(Body::empty())
                .expect("tile request should build"),
        )
        .await
        .expect("tile request should succeed");
    assert_eq!(rebuilt_region_tile_response.status(), StatusCode::OK);
    assert_eq!(
        bytes_response(rebuilt_region_tile_response).await,
        b"region-b"
    );

    let rebuilt_fallback_tile_response = router
        .oneshot(
            Request::builder()
                .uri("/api/basemap/tiles/2/0/0")
                .body(Body::empty())
                .expect("tile request should build"),
        )
        .await
        .expect("tile request should succeed");
    assert_eq!(rebuilt_fallback_tile_response.status(), StatusCode::OK);
    assert_eq!(
        bytes_response(rebuilt_fallback_tile_response).await,
        b"coarse-b"
    );

    shutdown_tx.send(()).expect("mock server should shut down");
    handle.await.expect("mock server task should finish");
}

#[tokio::test]
async fn cancels_running_world_job_and_rejects_duplicate_world_requests() {
    let temp_dir = TempDir::new().expect("temp dir should be created");
    let build_path = temp_dir.path().join("20260421.pmtiles");
    let build_bytes = create_source_pmtiles(&build_path, b"region-a", b"coarse-a");

    let (base_url, shutdown_tx, handle) = spawn_mock_server_with_delay(
        vec![MockBuild {
            key: "20260421.pmtiles".to_owned(),
            bytes: Arc::new(build_bytes),
        }],
        20,
    )
    .await;

    let context = Arc::new(
        AppContext::bootstrap(app_config(&temp_dir, &base_url))
            .await
            .expect("bootstrap should succeed"),
    );
    let router = build_router(context);

    let world_response = post_json(
        &router,
        "/api/settings/maps/world-to-6",
        json!({ "build_key": "20260421.pmtiles" }),
    )
    .await;
    assert_eq!(world_response.status(), StatusCode::CREATED);
    let world_payload = json_response(world_response).await;
    let job_id = world_payload["job_id"]
        .as_str()
        .expect("job id should exist")
        .to_owned();

    let duplicate_world_response = post_json(
        &router,
        "/api/settings/maps/world-to-6",
        json!({ "build_key": "20260421.pmtiles" }),
    )
    .await;
    assert_eq!(duplicate_world_response.status(), StatusCode::CONFLICT);

    let cancel_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/settings/maps/jobs/{job_id}/cancel"))
                .body(Body::empty())
                .expect("cancel request should build"),
        )
        .await
        .expect("cancel request should succeed");
    assert_eq!(cancel_response.status(), StatusCode::OK);

    wait_for_all_jobs(&router).await;

    let jobs_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/jobs")
                .body(Body::empty())
                .expect("jobs request should build"),
        )
        .await
        .expect("jobs request should succeed");
    let jobs_payload = json_response(jobs_response).await;
    let jobs = jobs_payload["jobs"]
        .as_array()
        .expect("jobs should be an array");
    assert_eq!(jobs.len(), 1);
    let cancelled_job = jobs
        .iter()
        .find(|job| job["id"].as_str() == Some(job_id.as_str()))
        .expect("cancelled job should exist");
    assert_eq!(cancelled_job["status"].as_str(), Some("cancelled"));
    assert_eq!(cancelled_job["current_step"].as_str(), Some("Cancelled"));

    let local_response = router
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/local")
                .body(Body::empty())
                .expect("local maps request should build"),
        )
        .await
        .expect("local maps request should succeed");
    let local_payload = json_response(local_response).await;
    let chunks = local_payload["chunks"]
        .as_array()
        .expect("chunks should be an array");
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0]["selected_build_ready"].as_bool(), Some(false));

    shutdown_tx.send(()).expect("mock server should shut down");
    handle.await.expect("mock server task should finish");
}

#[tokio::test]
async fn keeps_failed_and_cancelled_jobs_visible_while_hiding_completed_jobs() {
    let temp_dir = TempDir::new().expect("temp dir should be created");
    let build_path = temp_dir.path().join("20260421.pmtiles");
    let build_bytes = create_source_pmtiles(&build_path, b"region-a", b"coarse-a");

    let (base_url, shutdown_tx, handle) = spawn_mock_server(vec![MockBuild {
        key: "20260421.pmtiles".to_owned(),
        bytes: Arc::new(build_bytes),
    }])
    .await;

    let context = Arc::new(
        AppContext::bootstrap(app_config(&temp_dir, &base_url))
            .await
            .expect("bootstrap should succeed"),
    );
    let now = Utc::now().to_rfc3339();
    let insert_sql = format!(
        "INSERT INTO map_jobs \
         (id, kind, status, build_key, chunk_id, archive_id, error_message, current_step, progress_percent, segments_done, segments_total, created_at, updated_at, started_at, finished_at) \
         VALUES \
         ('completed-job', 'world-to-6', 'completed', '20260421.pmtiles', 'world-to-6', NULL, NULL, 'Completed', 100, 1, 1, '{now}', '{now}', '{now}', '{now}'), \
         ('failed-job', 'world-to-6', 'failed', '20260421.pmtiles', 'world-to-6', NULL, 'download failed', 'Failed', 50, 1, 2, '{now}', '{now}', '{now}', '{now}'), \
         ('cancelled-job', 'world-to-6', 'cancelled', '20260421.pmtiles', 'world-to-6', NULL, NULL, 'Cancelled', 10, 0, 2, '{now}', '{now}', '{now}', '{now}')"
    );
    context
        .db()
        .execute_unprepared(&insert_sql)
        .await
        .expect("job insert should succeed");
    let router = build_router(context);

    let jobs_response = router
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/jobs")
                .body(Body::empty())
                .expect("jobs request should build"),
        )
        .await
        .expect("jobs request should succeed");
    let jobs_payload = json_response(jobs_response).await;
    let jobs = jobs_payload["jobs"]
        .as_array()
        .expect("jobs should be an array");
    assert_eq!(jobs.len(), 2);
    assert!(
        jobs.iter()
            .all(|job| job["status"].as_str() != Some("completed"))
    );
    assert!(
        jobs.iter()
            .any(|job| job["id"].as_str() == Some("failed-job"))
    );
    assert!(
        jobs.iter()
            .any(|job| job["id"].as_str() == Some("cancelled-job"))
    );

    shutdown_tx.send(()).expect("mock server should shut down");
    handle.await.expect("mock server task should finish");
}

#[tokio::test]
async fn reconciles_cancel_requested_jobs_after_restart() {
    let temp_dir = TempDir::new().expect("temp dir should be created");
    let build_path = temp_dir.path().join("20260421.pmtiles");
    let build_bytes = create_source_pmtiles(&build_path, b"region-a", b"coarse-a");

    let (base_url, shutdown_tx, handle) = spawn_mock_server(vec![MockBuild {
        key: "20260421.pmtiles".to_owned(),
        bytes: Arc::new(build_bytes),
    }])
    .await;

    let config = app_config(&temp_dir, &base_url);
    let initial_context = AppContext::bootstrap(config.clone())
        .await
        .expect("bootstrap should succeed");
    let now = Utc::now().to_rfc3339();
    let insert_sql = format!(
        "INSERT INTO map_jobs \
         (id, kind, status, build_key, chunk_id, archive_id, error_message, current_step, progress_percent, segments_done, segments_total, created_at, updated_at, started_at, finished_at) \
         VALUES \
         ('orphaned-cancel-request', 'world-to-6', 'cancel_requested', '20260421.pmtiles', 'world-to-6', NULL, NULL, 'Cancellation requested', 7, 150, 5461, '{now}', '{now}', '{now}', NULL)"
    );
    initial_context
        .db()
        .execute_unprepared(&insert_sql)
        .await
        .expect("job insert should succeed");
    drop(initial_context);

    let restarted_context = Arc::new(
        AppContext::bootstrap(config)
            .await
            .expect("restart bootstrap should succeed"),
    );
    let router = build_router(restarted_context);

    let jobs_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/jobs")
                .body(Body::empty())
                .expect("jobs request should build"),
        )
        .await
        .expect("jobs request should succeed");
    let jobs_payload = json_response(jobs_response).await;
    let jobs = jobs_payload["jobs"]
        .as_array()
        .expect("jobs should be an array");
    let reconciled_job = jobs
        .iter()
        .find(|job| job["id"].as_str() == Some("orphaned-cancel-request"))
        .expect("reconciled job should exist");
    assert_eq!(reconciled_job["status"].as_str(), Some("cancelled"));
    assert_eq!(reconciled_job["current_step"].as_str(), Some("Cancelled"));

    let world_response = post_json(
        &router,
        "/api/settings/maps/world-to-6",
        json!({ "build_key": "20260421.pmtiles" }),
    )
    .await;
    assert_eq!(world_response.status(), StatusCode::CREATED);

    wait_for_all_jobs(&router).await;

    shutdown_tx.send(()).expect("mock server should shut down");
    handle.await.expect("mock server task should finish");
}

#[tokio::test]
async fn rejects_duplicate_area_extract_jobs_without_creating_extra_chunks() {
    let temp_dir = TempDir::new().expect("temp dir should be created");
    let build_path = temp_dir.path().join("20260421.pmtiles");
    let build_bytes = create_source_pmtiles(&build_path, b"region-a", b"coarse-a");

    let (base_url, shutdown_tx, handle) = spawn_mock_server(vec![MockBuild {
        key: "20260421.pmtiles".to_owned(),
        bytes: Arc::new(build_bytes),
    }])
    .await;

    let context = Arc::new(
        AppContext::bootstrap(app_config(&temp_dir, &base_url))
            .await
            .expect("bootstrap should succeed"),
    );
    let router = build_router(context);

    let (min_lon, min_lat, max_lon, max_lat) = build_inner_bbox(2, 2, 1);
    let request_body = json!({
        "build_key": "20260421.pmtiles",
        "label": "Regional detail",
        "min_lon": min_lon,
        "min_lat": min_lat,
        "max_lon": max_lon,
        "max_lat": max_lat,
        "max_zoom": 2
    });

    let first_response = post_json(
        &router,
        "/api/settings/maps/area-extract",
        request_body.clone(),
    )
    .await;
    assert_eq!(first_response.status(), StatusCode::CREATED);

    let duplicate_while_running = post_json(
        &router,
        "/api/settings/maps/area-extract",
        request_body.clone(),
    )
    .await;
    assert_eq!(duplicate_while_running.status(), StatusCode::CONFLICT);

    let local_during_download = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/local")
                .body(Body::empty())
                .expect("local maps request should build"),
        )
        .await
        .expect("local maps request should succeed");
    let local_during_download_payload = json_response(local_during_download).await;
    assert_eq!(
        local_during_download_payload["chunks"]
            .as_array()
            .expect("chunks should be an array")
            .len(),
        1
    );

    wait_for_all_jobs(&router).await;

    let duplicate_after_completion =
        post_json(&router, "/api/settings/maps/area-extract", request_body).await;
    assert_eq!(duplicate_after_completion.status(), StatusCode::CONFLICT);

    let local_after_completion = router
        .oneshot(
            Request::builder()
                .uri("/api/settings/maps/local")
                .body(Body::empty())
                .expect("local maps request should build"),
        )
        .await
        .expect("local maps request should succeed");
    let local_after_completion_payload = json_response(local_after_completion).await;
    assert_eq!(
        local_after_completion_payload["chunks"]
            .as_array()
            .expect("chunks should be an array")
            .len(),
        1
    );

    shutdown_tx.send(()).expect("mock server should shut down");
    handle.await.expect("mock server task should finish");
}
