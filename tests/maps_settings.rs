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
use http_body_util::BodyExt;
use pmtiles::{PmTilesWriter, TileCoord, TileType};
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
    let state = Arc::new(MockServerState {
        builds_json,
        files: Arc::new(files),
    });
    let router = Router::new()
        .route("/builds.json", get(builds_handler))
        .route("/{key}", get(pmtiles_handler))
        .with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener should bind");
    let addr = listener
        .local_addr()
        .expect("listener should have local addr");
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("mock server should run");
    });

    (format!("http://{addr}"), shutdown_tx, handle)
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
    let mut writer = PmTilesWriter::new(TileType::Png)
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
    AppConfig {
        database_url: format!(
            "sqlite:{}?mode=rwc",
            temp_dir.path().join("map-travel.sqlite").display()
        ),
        listen_addr: "127.0.0.1:0".parse().expect("listen addr should parse"),
        pmtiles_path: None,
        pmtiles_style_path: None,
        managed_maps_dir: Some(temp_dir.path().join("managed-maps")),
        protomaps_builds_metadata_url: format!("{base_url}/builds.json"),
        protomaps_builds_base_url: base_url.to_owned(),
        protomaps_style_base_url: "https://npm-style.protomaps.dev/style.json".to_owned(),
    }
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
        if jobs
            .iter()
            .all(|job| matches!(job["status"].as_str(), Some("completed" | "failed")))
        {
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
