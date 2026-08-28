use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::util::ServiceExt;

use map_travel::build_router;

mod support;
use support::test_context;

const SAMPLE_GPX: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="map-travel-test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Mueller Hut GPX Metadata</name>
    <desc>Imported GPX metadata description</desc>
    <author><name>Map Travel Tester</name></author>
    <keywords>alpine, hut</keywords>
    <link href="https://example.com/mueller-hut"><text>Track guide</text><type>text/html</type></link>
  </metadata>
  <trk>
    <name>Mueller Hut Track</name>
    <cmt>Track comment</cmt>
    <src>GPS device</src>
    <type>hiking</type>
    <number>7</number>
    <trkseg>
      <trkpt lat="-43.7219" lon="170.0937">
        <ele>1250.5</ele>
        <time>2026-02-10T08:00:00Z</time>
      </trkpt>
      <trkpt lat="-43.7201" lon="170.1049">
        <ele>1325.25</ele>
        <time>2026-02-10T09:30:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>
"#;

fn large_gpx() -> String {
    let mut body = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="map-travel-test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Big Track</name>
    <trkseg>
"#,
    );

    for index in 0..35_000 {
        let latitude = -43.7219 + (index as f64 * 0.00001);
        let longitude = 170.0937 + (index as f64 * 0.00001);
        body.push_str(&format!(
            "      <trkpt lat=\"{latitude:.5}\" lon=\"{longitude:.5}\"><time>2026-02-10T08:00:00Z</time></trkpt>\n"
        ));
    }

    body.push_str(
        r#"    </trkseg>
  </trk>
</gpx>
"#,
    );
    body
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

fn multipart_request(filename: &str, content_type: &str, body: &str) -> Request<Body> {
    multipart_request_with_collection_ids(filename, content_type, body, &[])
}

fn multipart_request_with_collection_ids(
    filename: &str,
    content_type: &str,
    body: &str,
    collection_ids: &[String],
) -> Request<Body> {
    let boundary = "X-BOUNDARY";
    let mut multipart_body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n{body}\r\n--{boundary}--\r\n"
    );
    let collection_fields = collection_ids
        .iter()
        .map(|collection_id| {
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"collection_ids\"\r\n\r\n{collection_id}\r\n"
            )
        })
        .collect::<String>();
    multipart_body = multipart_body.replace(
        &format!("--{boundary}--\r\n"),
        &format!("{collection_fields}--{boundary}--\r\n"),
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

async fn create_collection(router: &axum::Router) -> String {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/collections")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "name": "Track collection",
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
    assert_eq!(response.status(), StatusCode::CREATED);
    json_response(response).await["id"]
        .as_str()
        .expect("collection should have an id")
        .to_owned()
}

#[tokio::test]
async fn imports_a_gpx_track_and_makes_it_queryable_on_the_map() {
    let (_postgres, context) = test_context().await;
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
    assert_eq!(
        import_json["tracks"][0]["gpx_metadata"]["file_name"],
        "Mueller Hut GPX Metadata"
    );
    assert_eq!(
        import_json["tracks"][0]["gpx_metadata"]["source"],
        "GPS device"
    );
    assert_eq!(
        import_json["tracks"][0]["gpx_metadata"]["links"][0]["href"],
        "https://example.com/mueller-hut"
    );
    assert_eq!(
        import_json["tracks"][0]["original_filename"],
        "mueller-hut.gpx"
    );
    assert_eq!(
        serde_json::from_str::<Value>(
            import_json["tracks"][0]["geometry_json"]
                .as_str()
                .expect("geometry json should be a string")
        )
        .expect("geometry json should parse"),
        serde_json::json!({
            "type": "LineString",
            "coordinates": [
                [170.0937, -43.7219, 1250.5],
                [170.1049, -43.7201, 1325.25]
            ]
        })
    );

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
    assert_eq!(tracks[0]["original_filename"], "mueller-hut.gpx");
    assert_eq!(
        serde_json::from_str::<Value>(
            tracks[0]["geometry_json"]
                .as_str()
                .expect("geometry json should be a string")
        )
        .expect("geometry json should parse"),
        serde_json::json!({
            "type": "LineString",
            "coordinates": [
                [170.0937, -43.7219, 1250.5],
                [170.1049, -43.7201, 1325.25]
            ]
        })
    );
}

#[tokio::test]
async fn uses_the_gpx_metadata_name_when_a_track_has_no_name() {
    let (_postgres, context) = test_context().await;
    let router = build_router(context);
    let nameless_gpx = SAMPLE_GPX.replace("    <name>Mueller Hut Track</name>\n", "");

    let response = router
        .oneshot(multipart_request(
            "metadata-name.gpx",
            "application/gpx+xml",
            &nameless_gpx,
        ))
        .await
        .expect("import request should succeed");
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(
        json_response(response).await["tracks"][0]["title"],
        "Mueller Hut GPX Metadata"
    );
}

#[tokio::test]
async fn assigns_imported_tracks_to_multiple_collections_and_replaces_them_on_update() {
    let (_postgres, context) = test_context().await;
    let router = build_router(context);
    let first_collection_id = create_collection(&router).await;
    let second_collection_id = create_collection(&router).await;

    let import_response = router
        .clone()
        .oneshot(multipart_request_with_collection_ids(
            "mueller-hut.gpx",
            "application/gpx+xml",
            SAMPLE_GPX,
            &[first_collection_id.clone(), second_collection_id.clone()],
        ))
        .await
        .expect("import request should succeed");
    assert_eq!(import_response.status(), StatusCode::CREATED);
    let import_json = json_response(import_response).await;
    let track = &import_json["tracks"][0];
    let track_id = track["id"].as_str().expect("track should have an id");
    let mut expected_collection_ids =
        vec![first_collection_id.clone(), second_collection_id.clone()];
    expected_collection_ids.sort();
    assert_eq!(
        track["collection_ids"],
        serde_json::json!(expected_collection_ids)
    );

    let filtered_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/map-objects?min_lat=-44&min_lon=169&max_lat=-43&max_lon=171&object_type=track&collection_id={second_collection_id}"
                ))
                .body(Body::empty())
                .expect("filtered query should build"),
        )
        .await
        .expect("filtered query should succeed");
    assert_eq!(filtered_response.status(), StatusCode::OK);
    assert_eq!(
        json_response(filtered_response).await["tracks"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );

    let update_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/tracks/{track_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "title": "Updated track",
                        "notes": null,
                        "collection_ids": [second_collection_id]
                    })
                    .to_string(),
                ))
                .expect("update request should build"),
        )
        .await
        .expect("update request should succeed");
    assert_eq!(update_response.status(), StatusCode::OK);
    assert_eq!(
        json_response(update_response).await["collection_ids"],
        serde_json::json!([second_collection_id])
    );
}

#[tokio::test]
async fn rejects_invalid_gpx_uploads_with_a_clear_client_error() {
    let (_postgres, context) = test_context().await;
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

#[tokio::test]
async fn imports_large_valid_gpx_uploads() {
    let (_postgres, context) = test_context().await;
    let router = build_router(context);

    let large_gpx = large_gpx();
    assert!(
        large_gpx.len() > 2_000_000,
        "test GPX should exceed multipart default"
    );

    let import_response = router
        .oneshot(multipart_request(
            "big-track.gpx",
            "application/gpx+xml",
            &large_gpx,
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
    assert_eq!(import_json["tracks"][0]["title"], "Big Track");
    assert_eq!(
        import_json["tracks"][0]["original_filename"],
        "big-track.gpx"
    );
    let geometry_json = import_json["tracks"][0]["geometry_json"]
        .as_str()
        .expect("geometry json should be a string");
    assert!(geometry_json.contains("[170.0937,-43.7219]"));
}
