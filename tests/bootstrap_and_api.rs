use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::util::ServiceExt;

use map_travel::{AppConfig, AppContext, build_router, build_ui_router};

const SAMPLE_GPX: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="map-travel-test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Mueller Hut Track</name>
    <trkseg>
      <trkpt lat="-43.7219" lon="170.0937">
        <time>2026-02-10T08:00:00Z</time>
      </trkpt>
      <trkpt lat="-43.7201" lon="170.1049">
        <time>2026-02-10T09:30:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>
"#;

async fn json_response(response: axum::response::Response) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body should collect")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("response should be valid JSON")
}

async fn text_response(response: axum::response::Response) -> String {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body should collect")
        .to_bytes();
    String::from_utf8(bytes.to_vec()).expect("response should be valid UTF-8")
}

fn multipart_request(filename: &str, content_type: &str, body: &str) -> Request<Body> {
    let boundary = "X-BOUNDARY";
    let multipart_body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n{body}\r\n--{boundary}--\r\n"
    );

    Request::builder()
        .method("POST")
        .uri("/api/tracks/import")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(multipart_body))
        .expect("multipart request should build")
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
        vendored_basemap_dir: temp_dir.path().join("vendored-basemap"),
        managed_maps_dir: Some(temp_dir.path().join("managed-maps")),
        protomaps_builds_metadata_url: "https://build-metadata.protomaps.dev/builds.json"
            .to_owned(),
        protomaps_builds_base_url: "https://build.protomaps.com".to_owned(),
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
        vendored_basemap_dir: temp_dir.path().join("vendored-basemap"),
        managed_maps_dir: Some(temp_dir.path().join("managed-maps")),
        protomaps_builds_metadata_url: "https://build-metadata.protomaps.dev/builds.json"
            .to_owned(),
        protomaps_builds_base_url: "https://build.protomaps.com".to_owned(),
    })
    .await
    .expect("second bootstrap should succeed");

    assert_eq!(first_owner_id, second_context.owner_id());
    assert!(!second_context.owner_id().is_empty());
}

#[tokio::test]
async fn serves_the_app_shell_from_askama_templates() {
    let router = build_ui_router();

    for path in ["/", "/settings"] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("ui request should build"),
            )
            .await
            .expect("ui request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body = text_response(response).await;
        assert!(body.contains("<section id=\"workspace-screen\""));
        assert!(body.contains("<section id=\"settings-screen\""));
        assert!(body.contains("Map Travel"));
        assert!(
            body.contains("/src/main.ts") || body.contains("/assets/"),
            "expected a frontend entrypoint in the rendered shell: {body}"
        );
    }
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

#[tokio::test]
async fn updates_selected_place_fields() {
    let context = Arc::new(
        AppContext::bootstrap(AppConfig::for_tests())
            .await
            .expect("test bootstrap should succeed"),
    );
    let router = build_router(context);

    let create_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/places")
                .header("content-type", mime::APPLICATION_JSON.as_ref())
                .body(Body::from(
                    json!({
                        "name": "Old Name",
                        "category": "lookout",
                        "notes": "Before update",
                        "latitude": -27.4698,
                        "longitude": 153.0251,
                        "visit_start": null,
                        "visit_end": null,
                        "collection_ids": [],
                        "tag_names": []
                    })
                    .to_string(),
                ))
                .expect("place request should build"),
        )
        .await
        .expect("place request should succeed");
    let created = json_response(create_response).await;
    let place_id = created["id"].as_str().expect("place id").to_owned();

    let update_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/places/{place_id}"))
                .header("content-type", mime::APPLICATION_JSON.as_ref())
                .body(Body::from(
                    json!({
                        "name": "New Name",
                        "category": "camp",
                        "notes": "After update"
                    })
                    .to_string(),
                ))
                .expect("update request should build"),
        )
        .await
        .expect("update request should succeed");
    assert_eq!(update_response.status(), StatusCode::OK);
    let updated = json_response(update_response).await;
    assert_eq!(updated["name"], "New Name");
    assert_eq!(updated["category"], "camp");
    assert_eq!(updated["notes"], "After update");
}

#[tokio::test]
async fn updates_imported_track_fields() {
    let context = Arc::new(
        AppContext::bootstrap(AppConfig::for_tests())
            .await
            .expect("test bootstrap should succeed"),
    );
    let router = build_router(context);

    let import_response = router
        .clone()
        .oneshot(multipart_request(
            "mueller-hut.gpx",
            "application/gpx+xml",
            SAMPLE_GPX,
        ))
        .await
        .expect("import request should succeed");
    let imported = json_response(import_response).await;
    let track_id = imported["tracks"][0]["id"]
        .as_str()
        .expect("track id")
        .to_owned();

    let update_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/tracks/{track_id}"))
                .header("content-type", mime::APPLICATION_JSON.as_ref())
                .body(Body::from(
                    json!({
                        "title": "Renamed Track",
                        "notes": "Updated notes"
                    })
                    .to_string(),
                ))
                .expect("update request should build"),
        )
        .await
        .expect("update request should succeed");
    assert_eq!(update_response.status(), StatusCode::OK);
    let updated = json_response(update_response).await;
    assert_eq!(updated["title"], "Renamed Track");
    assert_eq!(updated["notes"], "Updated notes");
}

#[tokio::test]
async fn deletes_places_and_removes_them_from_view_queries() {
    let context = Arc::new(
        AppContext::bootstrap(AppConfig::for_tests())
            .await
            .expect("test bootstrap should succeed"),
    );
    let router = build_router(context);

    let collection_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/collections")
                .header("content-type", mime::APPLICATION_JSON.as_ref())
                .body(Body::from(
                    json!({
                        "name": "Delete Test",
                        "kind": "trip",
                        "starts_at": null,
                        "ends_at": null
                    })
                    .to_string(),
                ))
                .expect("collection request should build"),
        )
        .await
        .expect("collection request should succeed");
    let collection = json_response(collection_response).await;
    let collection_id = collection["id"].as_str().expect("collection id");

    let create_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/places")
                .header("content-type", mime::APPLICATION_JSON.as_ref())
                .body(Body::from(
                    json!({
                        "name": "Disposable Place",
                        "category": "lookout",
                        "notes": "Delete me",
                        "latitude": -27.4698,
                        "longitude": 153.0251,
                        "visit_start": null,
                        "visit_end": null,
                        "collection_ids": [collection_id],
                        "tag_names": ["delete-test"]
                    })
                    .to_string(),
                ))
                .expect("place request should build"),
        )
        .await
        .expect("place request should succeed");
    let created = json_response(create_response).await;
    let place_id = created["id"].as_str().expect("place id");

    let delete_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/places/{place_id}"))
                .body(Body::empty())
                .expect("delete request should build"),
        )
        .await
        .expect("delete request should succeed");
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);

    let map_objects = router
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/map-objects?min_lat=-28.0&min_lon=152.0&max_lat=-27.0&max_lon=154.0&object_type=place&collection_id={collection_id}"
                ))
                .body(Body::empty())
                .expect("map objects request should build"),
        )
        .await
        .expect("map objects request should succeed");
    assert_eq!(map_objects.status(), StatusCode::OK);
    let payload = json_response(map_objects).await;
    assert!(
        payload["places"]
            .as_array()
            .expect("places array")
            .is_empty()
    );
}

#[tokio::test]
async fn deletes_tracks_and_removes_them_from_view_queries() {
    let context = Arc::new(
        AppContext::bootstrap(AppConfig::for_tests())
            .await
            .expect("test bootstrap should succeed"),
    );
    let router = build_router(context);

    let import_response = router
        .clone()
        .oneshot(multipart_request(
            "mueller-hut.gpx",
            "application/gpx+xml",
            SAMPLE_GPX,
        ))
        .await
        .expect("import request should succeed");
    let imported = json_response(import_response).await;
    let track_id = imported["tracks"][0]["id"]
        .as_str()
        .expect("track id")
        .to_owned();

    let delete_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/tracks/{track_id}"))
                .body(Body::empty())
                .expect("delete request should build"),
        )
        .await
        .expect("delete request should succeed");
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);

    let map_objects = router
        .oneshot(
            Request::builder()
                .uri("/api/map-objects?min_lat=-44.0&min_lon=169.0&max_lat=-43.0&max_lon=171.0&object_type=track")
                .body(Body::empty())
                .expect("map objects request should build"),
        )
        .await
        .expect("map objects request should succeed");
    assert_eq!(map_objects.status(), StatusCode::OK);
    let payload = json_response(map_objects).await;
    assert!(
        payload["tracks"]
            .as_array()
            .expect("tracks array")
            .is_empty()
    );
}
