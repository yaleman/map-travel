#![deny(warnings)]
#![deny(deprecated)]
#![recursion_limit = "512"]
#![warn(unused_extern_crates)]
#![deny(clippy::suspicious)]
#![deny(clippy::perf)]
#![deny(clippy::todo)]
#![deny(clippy::unimplemented)]
#![deny(clippy::unwrap_used)]
#![deny(clippy::expect_used)]
#![deny(clippy::panic)]
#![deny(clippy::await_holding_lock)]
#![deny(clippy::needless_pass_by_value)]
#![deny(clippy::trivially_copy_pass_by_ref)]
#![deny(clippy::disallowed_types)]
#![deny(clippy::manual_let_else)]
#![deny(clippy::indexing_slicing)]
#![deny(clippy::unreachable)]

use axum::Router;
use clap::Parser;
use map_travel::{AppConfig, AppContext, build_router};
use std::{net::SocketAddr, path::PathBuf, process::ExitCode};
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Cli {
    /// Database URL
    #[arg(
        long,
        env = "MAP_TRAVEL_DATABASE_URL",
        default_value = "sqlite://map-travel.sqlite?mode=rwc"
    )]
    database_url: String,

    /// Listen address
    #[arg(long, env = "MAP_TRAVEL_LISTEN_ADDR", default_value = "127.0.0.1:9000")]
    listen_addr: SocketAddr,

    /// Path to PMTiles file
    #[arg(long, env = "MAP_TRAVEL_PMTILES_PATH")]
    pmtiles_path: Option<PathBuf>,

    /// Path to PMTiles style file
    #[arg(long, env = "MAP_TRAVEL_PMTILES_STYLE_PATH")]
    pmtiles_style_path: Option<PathBuf>,

    /// Directory for managed PMTiles cache files
    #[arg(long, env = "MAP_TRAVEL_MANAGED_MAPS_DIR")]
    managed_maps_dir: Option<PathBuf>,

    /// Protomaps build catalog URL
    #[arg(
        long,
        env = "MAP_TRAVEL_PROTOMAPS_BUILDS_METADATA_URL",
        default_value = "https://build-metadata.protomaps.dev/builds.json"
    )]
    protomaps_builds_metadata_url: String,

    /// Protomaps build base URL
    #[arg(
        long,
        env = "MAP_TRAVEL_PROTOMAPS_BUILDS_BASE_URL",
        default_value = "https://build.protomaps.com"
    )]
    protomaps_builds_base_url: String,

    /// Protomaps style service base URL
    #[arg(
        long,
        env = "MAP_TRAVEL_PROTOMAPS_STYLE_BASE_URL",
        default_value = "https://npm-style.protomaps.dev/style.json"
    )]
    protomaps_style_base_url: String,
}

#[tokio::main]
async fn main() -> Result<ExitCode, ExitCode> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cli = Cli::parse();

    let config = AppConfig {
        database_url: cli.database_url,
        listen_addr: cli.listen_addr,
        pmtiles_path: cli.pmtiles_path,
        pmtiles_style_path: cli.pmtiles_style_path,
        managed_maps_dir: cli.managed_maps_dir,
        protomaps_builds_metadata_url: cli.protomaps_builds_metadata_url,
        protomaps_builds_base_url: cli.protomaps_builds_base_url,
        protomaps_style_base_url: cli.protomaps_style_base_url,
    };

    let context = std::sync::Arc::new(AppContext::bootstrap(config).await.map_err(|error| {
        eprintln!("Failed to bootstrap application: {error}");
        ExitCode::FAILURE
    })?);
    let app: Router = build_router(context.clone()).fallback_service(
        ServeDir::new("frontend/dist")
            .not_found_service(ServeFile::new("frontend/dist/index.html")),
    );
    let listener = TcpListener::bind(context.config().listen_addr)
        .await
        .map_err(|error| {
            eprintln!("Failed to bind listener: {error}");
            ExitCode::FAILURE
        })?;

    tracing::info!("listening on http://{}", context.config().listen_addr);
    axum::serve(listener, app).await.map_err(|error| {
        eprintln!("Server error: {error}");
        ExitCode::FAILURE
    })?;
    Ok(ExitCode::SUCCESS)
}
