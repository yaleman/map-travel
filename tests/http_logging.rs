use std::net::SocketAddr;

use axum::{
    extract::ConnectInfo,
    http::{Request, Version, header::HeaderValue},
};

use map_travel::http_logging::request_log_fields;

#[test]
fn prefers_x_forwarded_for_over_connect_info() {
    let mut request = Request::builder()
        .method("GET")
        .uri("/api/map-objects?object_type=place")
        .version(Version::HTTP_11)
        .body(())
        .expect("request should build");
    request.headers_mut().insert(
        "x-forwarded-for",
        HeaderValue::from_static("203.0.113.10, 10.0.0.12"),
    );
    request.extensions_mut().insert(ConnectInfo(
        "192.0.2.44:9000"
            .parse::<SocketAddr>()
            .expect("socket address should parse"),
    ));

    let fields = request_log_fields(&request);
    assert_eq!(fields.client_ip, "203.0.113.10");
    assert_eq!(fields.method, "GET");
    assert_eq!(fields.uri, "/api/map-objects?object_type=place");
    assert_eq!(fields.version, "HTTP/1.1");
}

#[test]
fn falls_back_to_connect_info_when_forwarded_header_is_absent() {
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/places")
        .version(Version::HTTP_2)
        .body(())
        .expect("request should build");
    request.extensions_mut().insert(ConnectInfo(
        "198.51.100.7:443"
            .parse::<SocketAddr>()
            .expect("socket address should parse"),
    ));

    let fields = request_log_fields(&request);
    assert_eq!(fields.client_ip, "198.51.100.7");
    assert_eq!(fields.method, "POST");
    assert_eq!(fields.uri, "/api/places");
    assert_eq!(fields.version, "HTTP/2.0");
}
