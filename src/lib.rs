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

mod api;
mod app;
pub mod entities;
mod error;
pub mod http_logging;
mod maps;
mod maps_api;
mod ui;

pub use api::build_router;
pub use app::{AppConfig, AppContext};
pub use ui::build_router as build_ui_router;
