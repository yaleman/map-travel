use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::util::ServiceExt;

use map_travel::{AppConfig, AppContext, build_router};

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
async fn imports_a_gpx_track_and_makes_it_queryable_on_the_map() {
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
    assert_eq!(import_response.status(), StatusCode::CREATED);
    let import_json = json_response(import_response).await;
    assert_eq!(
        import_json["tracks"]
            .as_array()
            .expect("tracks array")
            .len(),
        1
    );
    assert_eq!(import_json["tracks"][0]["title"], "Mueller Hut Track");

    let query_response = router
        .oneshot(
            Request::builder()
                .uri("/api/map-objects?min_lat=-44.0&min_lon=169.0&max_lat=-43.0&max_lon=171.0&object_type=track")
                .body(Body::empty())
                .expect("query should build"),
        )
        .await
        .expect("map query should succeed");
    assert_eq!(query_response.status(), StatusCode::OK);
    let query_json = json_response(query_response).await;
    let tracks = query_json["tracks"]
        .as_array()
        .expect("tracks should be an array");
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0]["title"], "Mueller Hut Track");
}

#[tokio::test]
async fn rejects_invalid_gpx_uploads_with_a_clear_client_error() {
    let context = Arc::new(
        AppContext::bootstrap(AppConfig::for_tests())
            .await
            .expect("test bootstrap should succeed"),
    );
    let router = build_router(context);

    let response = router
        .oneshot(multipart_request(
            "broken.gpx",
            "application/gpx+xml",
            "<gpx><trk></gpx>",
        ))
        .await
        .expect("import request should succeed");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = json_response(response).await;
    assert!(
        body["error"]
            .as_str()
            .expect("error field should be present")
            .contains("GPX")
    );
}
