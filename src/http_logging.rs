use std::{net::SocketAddr, time::Instant};

use axum::{
    extract::{ConnectInfo, Request},
    middleware::Next,
    response::Response,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestLogFields {
    pub client_ip: String,
    pub method: String,
    pub uri: String,
    pub version: &'static str,
}

pub fn request_log_fields<B>(request: &Request<B>) -> RequestLogFields {
    RequestLogFields {
        client_ip: forwarded_client_ip(request)
            .or_else(|| connect_info_client_ip(request))
            .unwrap_or_else(|| "-".to_owned()),
        method: request.method().to_string(),
        uri: request.uri().to_string(),
        version: http_version_label(request.version()),
    }
}

pub async fn log_http_request(request: Request, next: Next) -> Response {
    let fields = request_log_fields(&request);
    let started_at = Instant::now();
    let response = next.run(request).await;
    tracing::info!(
        client_ip = %fields.client_ip,
        method = %fields.method,
        uri = %fields.uri,
        version = %fields.version,
        status = response.status().as_u16(),
        latency_ms = started_at.elapsed().as_millis(),
        "http request"
    );
    response
}

fn forwarded_client_ip<B>(request: &Request<B>) -> Option<String> {
    for header_name in ["x-forwarded-for", "x-real-ip"] {
        let value = request.headers().get(header_name)?.to_str().ok()?;
        let ip = value.split(',').next()?.trim();
        if !ip.is_empty() {
            return Some(ip.to_owned());
        }
    }
    None
}

fn connect_info_client_ip<B>(request: &Request<B>) -> Option<String> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|connect_info| connect_info.0.ip().to_string())
}

fn http_version_label(version: axum::http::Version) -> &'static str {
    match version {
        axum::http::Version::HTTP_09 => "HTTP/0.9",
        axum::http::Version::HTTP_10 => "HTTP/1.0",
        axum::http::Version::HTTP_11 => "HTTP/1.1",
        axum::http::Version::HTTP_2 => "HTTP/2.0",
        axum::http::Version::HTTP_3 => "HTTP/3.0",
        _ => "HTTP/?",
    }
}
