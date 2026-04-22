use std::{collections::HashMap, fs, path::Path};

use askama::Template;
use askama_web::WebTemplate;
use axum::{Router, routing::get};
use serde::Deserialize;

#[derive(Clone, Debug, Template, WebTemplate)]
#[template(path = "app.html")]
struct AppShellTemplate {
    script_src: String,
    stylesheet_href: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ViteManifestEntry {
    file: String,
    css: Option<Vec<String>>,
    #[serde(rename = "isEntry")]
    is_entry: Option<bool>,
}

#[derive(Debug)]
struct FrontendAssets {
    script_src: String,
    stylesheet_href: Option<String>,
}

pub fn build_router() -> Router {
    Router::new()
        .route("/", get(get_app_shell))
        .route("/settings", get(get_app_shell))
}

async fn get_app_shell() -> AppShellTemplate {
    let assets = load_frontend_assets();
    AppShellTemplate {
        script_src: assets.script_src,
        stylesheet_href: assets.stylesheet_href,
    }
}

fn load_frontend_assets() -> FrontendAssets {
    let manifest_path = Path::new("frontend/dist/manifest.json");
    if !manifest_path.exists() {
        return FrontendAssets {
            script_src: "/src/main.ts".to_owned(),
            stylesheet_href: None,
        };
    }

    let manifest = fs::read_to_string(manifest_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<HashMap<String, ViteManifestEntry>>(&raw).ok());
    let Some(manifest) = manifest else {
        tracing::warn!("failed to read frontend manifest, falling back to dev assets");
        return FrontendAssets {
            script_src: "/src/main.ts".to_owned(),
            stylesheet_href: None,
        };
    };

    let entry = manifest
        .get("index.html")
        .or_else(|| manifest.values().find(|entry| entry.is_entry == Some(true)));
    let Some(entry) = entry else {
        tracing::warn!(
            "frontend manifest did not contain an entrypoint, falling back to dev assets"
        );
        return FrontendAssets {
            script_src: "/src/main.ts".to_owned(),
            stylesheet_href: None,
        };
    };

    FrontendAssets {
        script_src: format_asset_path(&entry.file),
        stylesheet_href: entry
            .css
            .as_ref()
            .and_then(|files| files.first())
            .map(|file| format_asset_path(file)),
    }
}

fn format_asset_path(asset_path: &str) -> String {
    if asset_path.starts_with('/') {
        asset_path.to_owned()
    } else {
        format!("/{asset_path}")
    }
}

#[cfg(test)]
mod tests {
    use super::format_asset_path;

    #[test]
    fn prefixes_manifest_assets_with_a_root_slash() {
        assert_eq!(format_asset_path("assets/index.js"), "/assets/index.js");
        assert_eq!(format_asset_path("/assets/index.js"), "/assets/index.js");
    }
}
