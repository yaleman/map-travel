use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::util::ServiceExt;

use map_travel::{AppConfig, AppContext, build_router};

async fn json_response(response: axum::response::Response) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body should collect")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("response should be valid JSON")
}

#[tokio::test]
async fn bootstrap_creates_and_reuses_owner_id_for_same_database() {
    let temp_dir = TempDir::new().expect("temp dir should be created");
    let database_path = temp_dir.path().join("map-travel.sqlite");

    let first_context = AppContext::bootstrap(AppConfig {
        database_url: format!("sqlite:{}?mode=rwc", database_path.display()),
        listen_addr: "127.0.0.1:0".parse().expect("valid socket address"),
        pmtiles_path: None,
        pmtiles_style_path: None,
        managed_maps_dir: Some(temp_dir.path().join("managed-maps")),
        protomaps_builds_metadata_url: "https://build-metadata.protomaps.dev/builds.json"
            .to_owned(),
        protomaps_builds_base_url: "https://build.protomaps.com".to_owned(),
        protomaps_style_base_url: "https://npm-style.protomaps.dev/style.json".to_owned(),
    })
    .await
    .expect("first bootstrap should succeed");
    let first_owner_id = first_context.owner_id().to_owned();

    drop(first_context);

    let second_context = AppContext::bootstrap(AppConfig {
        database_url: format!("sqlite:{}?mode=rwc", database_path.display()),
        listen_addr: "127.0.0.1:0".parse().expect("valid socket address"),
        pmtiles_path: None,
        pmtiles_style_path: None,
        managed_maps_dir: Some(temp_dir.path().join("managed-maps")),
        protomaps_builds_metadata_url: "https://build-metadata.protomaps.dev/builds.json"
            .to_owned(),
        protomaps_builds_base_url: "https://build.protomaps.com".to_owned(),
        protomaps_style_base_url: "https://npm-style.protomaps.dev/style.json".to_owned(),
    })
    .await
    .expect("second bootstrap should succeed");

    assert_eq!(first_owner_id, second_context.owner_id());
    assert!(!second_context.owner_id().is_empty());
}

#[tokio::test]
async fn creates_places_and_filters_them_by_bounds_collection_and_type() {
    let context = Arc::new(
        AppContext::bootstrap(AppConfig::for_tests())
            .await
            .expect("test bootstrap should succeed"),
    );
    let router = build_router(context.clone());

    let collection_request = Request::builder()
        .method("POST")
        .uri("/api/collections")
        .header("content-type", mime::APPLICATION_JSON.as_ref())
        .body(Body::from(
            json!({
                "name": "New Zealand Walks",
                "kind": "trip",
                "starts_at": "2026-02-01T00:00:00Z",
                "ends_at": "2026-02-28T00:00:00Z"
            })
            .to_string(),
        ))
        .expect("collection request should build");
    let collection_response = router
        .clone()
        .oneshot(collection_request)
        .await
        .expect("collection request should succeed");
    assert_eq!(collection_response.status(), StatusCode::CREATED);
    let collection_json = json_response(collection_response).await;
    let collection_id = collection_json["id"]
        .as_str()
        .expect("collection response should include id")
        .to_owned();

    let place_request = Request::builder()
        .method("POST")
        .uri("/api/places")
        .header("content-type", mime::APPLICATION_JSON.as_ref())
        .body(Body::from(
            json!({
                "name": "Hooker Valley Trailhead",
                "category": "trailhead",
                "notes": "Start of the walk",
                "latitude": -43.7346,
                "longitude": 170.0963,
                "visit_start": "2026-02-10T09:00:00Z",
                "visit_end": "2026-02-10T10:00:00Z",
                "collection_ids": [collection_id],
                "tag_names": ["walk", "future"]
            })
            .to_string(),
        ))
        .expect("place request should build");
    let place_response = router
        .clone()
        .oneshot(place_request)
        .await
        .expect("place request should succeed");
    assert_eq!(place_response.status(), StatusCode::CREATED);

    let empty_query = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/map-objects?min_lat=-44.0&min_lon=171.0&max_lat=-43.0&max_lon=172.0&object_type=place")
                .body(Body::empty())
                .expect("empty query should build"),
        )
        .await
        .expect("empty query should succeed");
    assert_eq!(empty_query.status(), StatusCode::OK);
    let empty_json = json_response(empty_query).await;
    assert_eq!(
        empty_json["places"]
            .as_array()
            .expect("places should be an array")
            .len(),
        0
    );

    let filtered_query = router
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/map-objects?min_lat=-44.0&min_lon=169.0&max_lat=-43.0&max_lon=171.0&object_type=place&collection_id={collection_id}&tag=future"
                ))
                .body(Body::empty())
                .expect("filtered query should build"),
        )
        .await
        .expect("filtered query should succeed");
    assert_eq!(filtered_query.status(), StatusCode::OK);
    let filtered_json = json_response(filtered_query).await;
    let places = filtered_json["places"]
        .as_array()
        .expect("places should be an array");
    assert_eq!(places.len(), 1);
    assert_eq!(places[0]["name"], "Hooker Valley Trailhead");
    assert!(
        filtered_json["tracks"]
            .as_array()
            .expect("tracks should be an array")
            .is_empty()
    );
}
