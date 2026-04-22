use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use pmtiles::{
    AsyncPmTilesReader, Compression, HttpBackend, MmapBackend, PmTilesWriter, TileCoord, TileId,
    TileType,
};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{
    entities::{map_archive, map_chunk, map_job, metadata, protomaps_build},
    error::{AppError, AppResult},
};

const SELECTED_BUILD_METADATA_KEY: &str = "selected_protomaps_build_key";
const WORLD_TO_6_CHUNK_ID: &str = "world-to-6";
const MAX_MERCATOR_LAT: f64 = 85.051_129;
const ACTIVE_JOB_STATUSES: [&str; 3] = ["queued", "running", "cancel_requested"];
const CANCELLED_STEP: &str = "Cancelled";
const INTERRUPTED_STEP: &str = "Interrupted";
const INTERRUPTED_MESSAGE: &str = "Map service restarted before the job completed.";

#[derive(Clone, Debug)]
pub struct MapsConfig {
    pub managed_maps_dir: PathBuf,
    pub protomaps_builds_metadata_url: String,
    pub protomaps_builds_base_url: String,
    pub protomaps_style_base_url: String,
}

#[derive(Clone)]
pub struct MapsService {
    db: DatabaseConnection,
    config: MapsConfig,
    client: pmtiles::reqwest::Client,
    readers: Arc<RwLock<HashMap<String, Arc<AsyncPmTilesReader<MmapBackend>>>>>,
    cancel_flags: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildCatalogResponse {
    pub selected_build_key: Option<String>,
    pub builds: Vec<BuildRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildRecord {
    pub key: String,
    pub version: Option<String>,
    pub size: i64,
    pub uploaded: String,
    pub md5_sum: Option<String>,
    pub b3_sum: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalMapsResponse {
    pub selected_build_key: Option<String>,
    pub chunks: Vec<ChunkRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChunkRecord {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub min_lon: Option<f64>,
    pub min_lat: Option<f64>,
    pub max_lon: Option<f64>,
    pub max_lat: Option<f64>,
    pub max_zoom: i32,
    pub enabled: bool,
    pub display_order: i32,
    pub stale: bool,
    pub selected_build_ready: bool,
    pub latest_job: Option<JobRecord>,
    pub archives: Vec<ArchiveRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveRecord {
    pub id: String,
    pub build_key: String,
    pub relative_path: String,
    pub tile_type: String,
    pub min_zoom: i32,
    pub max_zoom: i32,
    pub min_lon: f64,
    pub min_lat: f64,
    pub max_lon: f64,
    pub max_lat: f64,
    pub file_size_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobListResponse {
    pub jobs: Vec<JobRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobRecord {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub build_key: String,
    pub chunk_id: Option<String>,
    pub archive_id: Option<String>,
    pub error_message: Option<String>,
    pub current_step: String,
    pub progress_percent: i32,
    pub segments_done: i32,
    pub segments_total: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnqueuedJobResponse {
    pub job_id: String,
    pub chunk_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RebuildChunksResponse {
    pub job_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ManagedBasemapSummary {
    pub tile_type: TileType,
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub bounds: [f64; 4],
    pub message: Option<String>,
}

#[derive(Debug)]
pub struct ManagedTile {
    pub bytes: Bytes,
    pub tile_type: TileType,
    pub tile_compression: Compression,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BuildCatalogEntry {
    pub key: String,
    pub size: i64,
    pub uploaded: String,
    pub version: Option<String>,
    #[serde(default)]
    pub md5sum: Option<String>,
    #[serde(default)]
    pub b3sum: Option<String>,
}

#[derive(Debug, Clone)]
struct ManagedLayer {
    chunk: map_chunk::Model,
    archive: map_archive::Model,
}

impl MapsService {
    pub async fn new(db: DatabaseConnection, config: MapsConfig) -> AppResult<Self> {
        tokio::fs::create_dir_all(&config.managed_maps_dir)
            .await
            .map_err(|error| {
                AppError::Internal(format!("could not create managed maps directory: {error}"))
            })?;
        let client = pmtiles::reqwest::Client::builder()
            .use_rustls_tls()
            .build()
            .map_err(|error| AppError::Internal(format!("could not build HTTP client: {error}")))?;
        let service = Self {
            db,
            config,
            client,
            readers: Arc::new(RwLock::new(HashMap::new())),
            cancel_flags: Arc::new(RwLock::new(HashMap::new())),
        };
        service.reconcile_orphaned_jobs().await?;
        Ok(service)
    }

    pub fn config(&self) -> &MapsConfig {
        &self.config
    }

    pub async fn fetch_build_catalog(&self) -> AppResult<BuildCatalogResponse> {
        let remote = self
            .client
            .get(&self.config.protomaps_builds_metadata_url)
            .send()
            .await;

        if let Ok(response) = remote {
            let response = response.error_for_status().map_err(|error| {
                AppError::InvalidRequest(format!("could not fetch Protomaps builds: {error}"))
            })?;
            let body = response.text().await.map_err(|error| {
                AppError::Internal(format!(
                    "could not read Protomaps build metadata response: {error}"
                ))
            })?;
            let entries =
                serde_json::from_str::<Vec<BuildCatalogEntry>>(&body).map_err(|error| {
                    AppError::Internal(format!("could not parse Protomaps build metadata: {error}"))
                })?;
            self.save_build_catalog(&entries).await?;
        }

        let builds = protomaps_build::Entity::find()
            .order_by_desc(protomaps_build::Column::Key)
            .all(&self.db)
            .await?;
        let selected_build_key = self.selected_build_key().await?;
        Ok(BuildCatalogResponse {
            selected_build_key,
            builds: builds.into_iter().map(BuildRecord::from).collect(),
        })
    }

    async fn reconcile_orphaned_jobs(&self) -> AppResult<()> {
        let jobs = map_job::Entity::find()
            .filter(map_job::Column::Status.is_in(ACTIVE_JOB_STATUSES))
            .all(&self.db)
            .await?;
        if jobs.is_empty() {
            return Ok(());
        }

        let now = Utc::now();
        for job in jobs {
            let original_status = job.status.clone();
            let job_id = job.id.clone();
            let build_key = job.build_key.clone();
            let chunk_id = job.chunk_id.clone();
            let reconciled_status = match original_status.as_str() {
                "cancel_requested" => "cancelled",
                "queued" | "running" => "failed",
                _ => continue,
            };
            let mut model: map_job::ActiveModel = job.into();
            match original_status.as_str() {
                "cancel_requested" => {
                    model.status = Set(reconciled_status.to_owned());
                    model.current_step = Set(CANCELLED_STEP.to_owned());
                    model.error_message = Set(None);
                }
                "queued" | "running" => {
                    model.status = Set(reconciled_status.to_owned());
                    model.current_step = Set(INTERRUPTED_STEP.to_owned());
                    model.error_message = Set(Some(INTERRUPTED_MESSAGE.to_owned()));
                }
                _ => continue,
            }
            model.finished_at = Set(Some(now));
            model.updated_at = Set(now);
            model.update(&self.db).await?;
            tracing::warn!(
                job_id = %job_id,
                original_status = %original_status,
                reconciled_status = %reconciled_status,
                build_key = %build_key,
                chunk_id = ?chunk_id,
                "reconciled orphaned managed map job after service startup"
            );
        }

        Ok(())
    }

    pub async fn list_local_maps(&self) -> AppResult<LocalMapsResponse> {
        let selected_build_key = self.selected_build_key().await?;
        let chunks = map_chunk::Entity::find()
            .order_by_asc(map_chunk::Column::DisplayOrder)
            .order_by_asc(map_chunk::Column::CreatedAt)
            .all(&self.db)
            .await?;
        let archives = map_archive::Entity::find().all(&self.db).await?;
        let jobs = map_job::Entity::find()
            .order_by_desc(map_job::Column::CreatedAt)
            .all(&self.db)
            .await?;

        let mut archives_by_chunk = HashMap::<String, Vec<map_archive::Model>>::new();
        for archive in archives {
            archives_by_chunk
                .entry(archive.chunk_id.clone())
                .or_default()
                .push(archive);
        }
        let mut latest_job_by_chunk = HashMap::<String, JobRecord>::new();
        for job in jobs {
            let Some(chunk_id) = &job.chunk_id else {
                continue;
            };
            if let Some(selected_build_key) = &selected_build_key
                && &job.build_key != selected_build_key
            {
                continue;
            }
            latest_job_by_chunk
                .entry(chunk_id.clone())
                .or_insert_with(|| JobRecord::from(job));
        }

        let chunks = chunks
            .into_iter()
            .map(|chunk| {
                let archives = archives_by_chunk.remove(&chunk.id).unwrap_or_default();
                let has_any_archive = !archives.is_empty();
                let selected_build_ready = selected_build_key.as_ref().is_some_and(|build_key| {
                    archives
                        .iter()
                        .any(|archive| archive.build_key == *build_key)
                });
                let stale = selected_build_key.as_ref().is_some_and(|build_key| {
                    has_any_archive
                        && !archives
                            .iter()
                            .any(|archive| archive.build_key == *build_key)
                });
                ChunkRecord {
                    latest_job: latest_job_by_chunk.remove(&chunk.id),
                    id: chunk.id,
                    label: chunk.label,
                    kind: chunk.kind,
                    min_lon: chunk.min_lon,
                    min_lat: chunk.min_lat,
                    max_lon: chunk.max_lon,
                    max_lat: chunk.max_lat,
                    max_zoom: chunk.max_zoom,
                    enabled: chunk.enabled,
                    display_order: chunk.display_order,
                    stale,
                    selected_build_ready,
                    archives: archives.into_iter().map(ArchiveRecord::from).collect(),
                }
            })
            .collect();

        Ok(LocalMapsResponse {
            selected_build_key,
            chunks,
        })
    }

    pub async fn list_jobs(&self) -> AppResult<JobListResponse> {
        let jobs = map_job::Entity::find()
            .order_by_desc(map_job::Column::CreatedAt)
            .all(&self.db)
            .await?;
        Ok(JobListResponse {
            jobs: jobs.into_iter().map(JobRecord::from).collect(),
        })
    }

    pub async fn queue_world_to_6(&self, build_key: &str) -> AppResult<EnqueuedJobResponse> {
        let chunk = self.ensure_world_chunk().await?;
        self.ensure_selected_build_key(build_key).await?;
        self.ensure_chunk_ready_for_enqueue(build_key, &chunk.id)
            .await?;
        let job = self
            .enqueue_job("world-to-6", build_key, Some(chunk.id.clone()))
            .await?;
        self.spawn_job(job.id.clone());
        Ok(EnqueuedJobResponse {
            job_id: job.id,
            chunk_id: chunk.id,
        })
    }

    pub async fn queue_area_extract(
        &self,
        label: String,
        build_key: &str,
        min_lon: f64,
        min_lat: f64,
        max_lon: f64,
        max_lat: f64,
        max_zoom: i32,
    ) -> AppResult<EnqueuedJobResponse> {
        validate_bbox(min_lon, min_lat, max_lon, max_lat)?;
        self.ensure_selected_build_key(build_key).await?;
        let chunk = if let Some(existing) = self
            .find_matching_area_chunk(min_lon, min_lat, max_lon, max_lat, max_zoom)
            .await?
        {
            existing
        } else {
            let now = Utc::now();
            map_chunk::ActiveModel {
                id: Set(Uuid::new_v4().to_string()),
                label: Set(label),
                kind: Set("area".to_owned()),
                min_lon: Set(Some(min_lon)),
                min_lat: Set(Some(min_lat)),
                max_lon: Set(Some(max_lon)),
                max_lat: Set(Some(max_lat)),
                max_zoom: Set(max_zoom),
                enabled: Set(true),
                display_order: Set(self.next_display_order().await?),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(&self.db)
            .await?
        };
        self.ensure_chunk_ready_for_enqueue(build_key, &chunk.id)
            .await?;
        let job = self
            .enqueue_job("area-extract", build_key, Some(chunk.id.clone()))
            .await?;
        self.spawn_job(job.id.clone());
        Ok(EnqueuedJobResponse {
            job_id: job.id,
            chunk_id: chunk.id,
        })
    }

    pub async fn update_active_layers(
        &self,
        selected_build_key: &str,
        layers: &[ActiveLayerUpdate],
    ) -> AppResult<()> {
        self.set_selected_build_key(selected_build_key).await?;
        let all_chunks = map_chunk::Entity::find().all(&self.db).await?;
        let layer_map = layers
            .iter()
            .map(|layer| (layer.chunk_id.clone(), layer))
            .collect::<HashMap<_, _>>();

        for chunk in all_chunks {
            let now = Utc::now();
            let (enabled, display_order) = if let Some(layer) = layer_map.get(&chunk.id) {
                (layer.enabled, layer.display_order)
            } else {
                (false, chunk.display_order)
            };
            let mut model: map_chunk::ActiveModel = chunk.into();
            model.enabled = Set(enabled);
            model.display_order = Set(display_order);
            model.updated_at = Set(now);
            model.update(&self.db).await?;
        }

        Ok(())
    }

    pub async fn rebuild_chunks(
        &self,
        build_key: &str,
        chunk_ids: Option<Vec<String>>,
    ) -> AppResult<RebuildChunksResponse> {
        self.set_selected_build_key(build_key).await?;
        let mut query = map_chunk::Entity::find();
        if let Some(chunk_ids) = chunk_ids.clone()
            && !chunk_ids.is_empty()
        {
            query = query.filter(map_chunk::Column::Id.is_in(chunk_ids));
        }
        let chunks = query.all(&self.db).await?;
        let mut job_ids = Vec::new();
        for chunk in chunks {
            if self.archive_exists_for_chunk(build_key, &chunk.id).await?
                || self
                    .find_active_job_for_chunk(build_key, &chunk.id)
                    .await?
                    .is_some()
            {
                continue;
            }
            let job = self
                .enqueue_job("rebuild-chunk", build_key, Some(chunk.id))
                .await?;
            job_ids.push(job.id.clone());
            self.spawn_job(job.id);
        }
        Ok(RebuildChunksResponse { job_ids })
    }

    pub async fn cancel_job(&self, job_id: &str) -> AppResult<()> {
        let Some(job) = map_job::Entity::find_by_id(job_id.to_owned())
            .one(&self.db)
            .await?
        else {
            return Err(AppError::InvalidRequest(
                "map job does not exist".to_owned(),
            ));
        };
        let was_queued = job.status == "queued";

        match job.status.as_str() {
            "completed" | "failed" | "cancelled" => {
                return Err(AppError::InvalidRequest(
                    "map job is no longer active".to_owned(),
                ));
            }
            _ => {}
        }

        self.set_cancel_flag(job_id, true).await;

        let now = Utc::now();
        let mut model: map_job::ActiveModel = job.into();
        if was_queued {
            model.status = Set("cancelled".to_owned());
            model.current_step = Set(CANCELLED_STEP.to_owned());
            model.finished_at = Set(Some(now));
        } else {
            model.status = Set("cancel_requested".to_owned());
            model.current_step = Set("Cancellation requested".to_owned());
        }
        model.updated_at = Set(now);
        model.update(&self.db).await?;
        Ok(())
    }

    pub async fn managed_basemap_summary(&self) -> AppResult<Option<ManagedBasemapSummary>> {
        let layers = self.active_layers_for_selected_build().await?;
        if layers.is_empty() {
            return Ok(None);
        }
        let first_reader = self.reader_for_archive(&layers[0].archive).await?;
        let first_header = first_reader.get_header();
        let bounds = union_bounds(layers.iter().map(|layer| {
            (
                layer.archive.min_lon,
                layer.archive.min_lat,
                layer.archive.max_lon,
                layer.archive.max_lat,
            )
        }));
        let has_world_layer = layers
            .iter()
            .any(|layer| layer.chunk.id == WORLD_TO_6_CHUNK_ID);
        Ok(Some(ManagedBasemapSummary {
            tile_type: first_header.tile_type,
            min_zoom: layers
                .iter()
                .map(|layer| u8::try_from(layer.archive.min_zoom).unwrap_or(0))
                .min()
                .unwrap_or(first_header.min_zoom),
            max_zoom: layers
                .iter()
                .map(|layer| u8::try_from(layer.archive.max_zoom).unwrap_or(first_header.max_zoom))
                .max()
                .unwrap_or(first_header.max_zoom),
            bounds,
            message: if has_world_layer {
                None
            } else {
                Some(
                    "No world layer is active for the selected build, so coverage is limited to extracted regions."
                        .to_owned(),
                )
            },
        }))
    }

    pub async fn managed_tile(&self, coord: TileCoord) -> AppResult<Option<ManagedTile>> {
        let layers = self.active_layers_for_selected_build().await?;
        for layer in layers {
            let reader = self.reader_for_archive(&layer.archive).await?;
            if let Some(bytes) = reader.get_tile(coord).await.map_err(|error| {
                AppError::Internal(format!("could not read PMTiles tile: {error}"))
            })? {
                let header = reader.get_header();
                return Ok(Some(ManagedTile {
                    bytes,
                    tile_type: header.tile_type,
                    tile_compression: header.tile_compression,
                }));
            }
        }
        Ok(None)
    }

    pub async fn managed_style(&self) -> AppResult<Option<serde_json::Value>> {
        let layers = self.active_layers_for_selected_build().await?;
        if layers.is_empty() {
            return Ok(None);
        }
        let first_reader = self.reader_for_archive(&layers[0].archive).await?;
        let header = first_reader.get_header();
        let summary = self
            .managed_basemap_summary()
            .await?
            .ok_or_else(|| AppError::InvalidRequest("No managed basemap is active".to_owned()))?;

        match header.tile_type {
            TileType::Png | TileType::Jpeg | TileType::Webp | TileType::Avif => {
                Ok(Some(serde_json::json!({
                    "version": 8,
                    "sources": {
                        "basemap": {
                            "type": "raster",
                            "tiles": ["/api/basemap/tiles/{z}/{x}/{y}"],
                            "tileSize": 256,
                            "minzoom": summary.min_zoom,
                            "maxzoom": summary.max_zoom
                        }
                    },
                    "layers": [
                        {
                            "id": "basemap",
                            "type": "raster",
                            "source": "basemap"
                        }
                    ]
                })))
            }
            TileType::Mvt | TileType::Mlt => {
                let build_key = self.selected_build_key().await?.ok_or_else(|| {
                    AppError::InvalidRequest("No selected build configured".to_owned())
                })?;
                let build_id = build_key.trim_end_matches(".pmtiles");
                let separator = if self.config.protomaps_style_base_url.contains('?') {
                    '&'
                } else {
                    '?'
                };
                let style_url = format!(
                    "{}{separator}version=5.0.0&theme=light&tiles={build_id}&lang=en",
                    self.config.protomaps_style_base_url
                );
                let style = self
                    .client
                    .get(style_url)
                    .send()
                    .await
                    .map_err(|error| {
                        AppError::InvalidRequest(format!(
                            "could not fetch Protomaps style JSON: {error}"
                        ))
                    })?
                    .error_for_status()
                    .map_err(|error| {
                        AppError::InvalidRequest(format!(
                            "could not fetch Protomaps style JSON: {error}"
                        ))
                    })?
                    .text()
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "could not read Protomaps style JSON response: {error}"
                        ))
                    })?;
                let style = serde_json::from_str::<serde_json::Value>(&style).map_err(|error| {
                    AppError::Internal(format!("could not parse Protomaps style JSON: {error}"))
                })?;

                Ok(Some(rewrite_style_sources(style)))
            }
            TileType::Unknown => Ok(None),
        }
    }

    pub async fn managed_tilejson(&self) -> AppResult<Option<serde_json::Value>> {
        let layers = self.active_layers_for_selected_build().await?;
        if layers.is_empty() {
            return Ok(None);
        }
        let reader = self.reader_for_archive(&layers[0].archive).await?;
        let summary = self
            .managed_basemap_summary()
            .await?
            .ok_or_else(|| AppError::InvalidRequest("No managed basemap is active".to_owned()))?;
        let mut value = match reader
            .parse_tilejson(vec!["/api/basemap/tiles/{z}/{x}/{y}".to_owned()])
            .await
        {
            Ok(tilejson) => serde_json::to_value(tilejson).map_err(|error| {
                AppError::Internal(format!("could not serialize TileJSON: {error}"))
            })?,
            Err(_) => serde_json::json!({
                "tilejson": "3.0.0",
                "tiles": ["/api/basemap/tiles/{z}/{x}/{y}"]
            }),
        };
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "tiles".to_owned(),
                serde_json::json!(["/api/basemap/tiles/{z}/{x}/{y}"]),
            );
            object.insert("minzoom".to_owned(), serde_json::json!(summary.min_zoom));
            object.insert("maxzoom".to_owned(), serde_json::json!(summary.max_zoom));
            object.insert("bounds".to_owned(), serde_json::json!(summary.bounds));
        }
        Ok(Some(value))
    }

    fn spawn_job(&self, job_id: String) {
        let service = self.clone();
        tokio::spawn(async move {
            if let Err(error) = service.run_job(&job_id).await {
                tracing::error!(job_id = %job_id, error = %error, "managed map job crashed");
            }
        });
    }

    async fn run_job(&self, job_id: &str) -> AppResult<()> {
        let Some(job) = map_job::Entity::find_by_id(job_id.to_owned())
            .one(&self.db)
            .await?
        else {
            self.clear_cancel_flag(job_id).await;
            return Ok(());
        };
        if job.status == "cancelled" || self.is_cancel_requested(job_id).await {
            self.clear_cancel_flag(job_id).await;
            return Ok(());
        }
        let log_job_id = job.id.clone();
        let log_job_kind = job.kind.clone();
        let log_build_key = job.build_key.clone();
        let log_chunk_id = job.chunk_id.clone();
        let started = Instant::now();
        tracing::info!(
            job_id = %log_job_id,
            kind = %log_job_kind,
            build_key = %log_build_key,
            chunk_id = ?log_chunk_id,
            "starting managed map job"
        );

        let now = Utc::now();
        let mut active_job: map_job::ActiveModel = job.into();
        active_job.status = Set("running".to_owned());
        active_job.current_step = Set("Preparing extract".to_owned());
        active_job.progress_percent = Set(1);
        active_job.started_at = Set(Some(now));
        active_job.updated_at = Set(now);
        let job = active_job.update(&self.db).await?;

        let result = self.materialize_job(&job).await;
        let finished_at = Utc::now();
        let mut final_job: map_job::ActiveModel = job.into();
        match result {
            Ok(archive_id) => {
                tracing::info!(
                    job_id = %log_job_id,
                    archive_id = %archive_id,
                    elapsed_ms = started.elapsed().as_millis(),
                    "managed map job completed"
                );
                final_job.status = Set("completed".to_owned());
                final_job.archive_id = Set(Some(archive_id));
                final_job.error_message = Set(None);
                final_job.current_step = Set("Completed".to_owned());
                final_job.progress_percent = Set(100);
            }
            Err(AppError::Cancelled(reason)) => {
                tracing::info!(
                    job_id = %log_job_id,
                    kind = %log_job_kind,
                    build_key = %log_build_key,
                    chunk_id = ?log_chunk_id,
                    elapsed_ms = started.elapsed().as_millis(),
                    reason = %reason,
                    "managed map job cancelled"
                );
                final_job.status = Set("cancelled".to_owned());
                final_job.error_message = Set(None);
                final_job.current_step = Set(CANCELLED_STEP.to_owned());
            }
            Err(error) => {
                tracing::error!(
                    job_id = %log_job_id,
                    kind = %log_job_kind,
                    build_key = %log_build_key,
                    chunk_id = ?log_chunk_id,
                    elapsed_ms = started.elapsed().as_millis(),
                    error = %error,
                    "managed map job failed"
                );
                final_job.status = Set("failed".to_owned());
                final_job.error_message = Set(Some(error.to_string()));
                final_job.current_step = Set("Failed".to_owned());
            }
        }
        final_job.finished_at = Set(Some(finished_at));
        final_job.updated_at = Set(finished_at);
        final_job.update(&self.db).await?;
        self.clear_cancel_flag(job_id).await;
        Ok(())
    }

    async fn materialize_job(&self, job: &map_job::Model) -> AppResult<String> {
        let started = Instant::now();
        let cancel_flag = self.cancel_flag(&job.id).await;
        let chunk_id = job
            .chunk_id
            .clone()
            .ok_or_else(|| AppError::Internal("map job is missing a chunk id".to_owned()))?;
        let chunk = map_chunk::Entity::find_by_id(chunk_id.clone())
            .one(&self.db)
            .await?
            .ok_or_else(|| AppError::Internal("map chunk should exist for job".to_owned()))?;
        self.ensure_job_not_cancelled(&job.id).await?;
        let log_chunk_id = chunk.id.clone();
        let log_chunk_label = chunk.label.clone();

        let source_url = format!(
            "{}/{}",
            self.config.protomaps_builds_base_url.trim_end_matches('/'),
            job.build_key
        );
        tracing::info!(
            job_id = %job.id,
            chunk_id = %log_chunk_id,
            chunk_label = %log_chunk_label,
            build_key = %job.build_key,
            source_url = %source_url,
            "opening remote PMTiles archive"
        );
        let reader =
            AsyncPmTilesReader::<HttpBackend>::new_with_url(self.client.clone(), source_url)
                .await
                .map_err(|error| {
                    AppError::InvalidRequest(format!(
                        "could not open remote PMTiles archive: {error}"
                    ))
                })?;
        let remote_header = reader.get_header();
        let coords = coords_for_chunk(&chunk)?;
        let relative_path = archive_filename(&chunk.id, &job.build_key);
        let absolute_path = self.config.managed_maps_dir.join(&relative_path);
        if let Some(parent) = absolute_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                AppError::Internal(format!(
                    "could not create archive parent directory: {error}"
                ))
            })?;
        }

        let metadata = match reader.get_metadata().await {
            Ok(metadata) => metadata,
            Err(error) => {
                tracing::warn!(
                    job_id = %job.id,
                    chunk_id = %log_chunk_id,
                    build_key = %job.build_key,
                    error = %error,
                    "could not read remote PMTiles metadata, using empty metadata object"
                );
                "{}".to_owned()
            }
        };
        let (min_lon, min_lat, max_lon, max_lat) = bounds_for_chunk(&chunk);
        let center_lon = (min_lon + max_lon) / 2.0;
        let center_lat = (min_lat + max_lat) / 2.0;
        let max_zoom = u8::try_from(chunk.max_zoom).map_err(|error| {
            AppError::Internal(format!("invalid max zoom stored in chunk: {error}"))
        })?;
        let segments_total = i32::try_from(coords.len()).map_err(|error| {
            AppError::Internal(format!("too many tile segments in job: {error}"))
        })?;
        self.ensure_job_not_cancelled(&job.id).await?;
        tracing::info!(
            job_id = %job.id,
            chunk_id = %log_chunk_id,
            chunk_label = %log_chunk_label,
            build_key = %job.build_key,
            tile_type = %tile_type_name(remote_header.tile_type),
            min_zoom = remote_header.min_zoom,
            max_zoom = chunk.max_zoom,
            segments_total,
            bounds = %format!("{min_lat:.4},{min_lon:.4} -> {max_lat:.4},{max_lon:.4}"),
            output_path = %relative_path,
            "computed managed map extract plan"
        );
        self.update_job_progress(&job.id, "Downloading tiles", 5, 0, segments_total)
            .await?;
        let mut tiles = Vec::new();
        let mut found_any_tiles = false;
        let total_coords = coords.len();
        for (index, coord) in coords.into_iter().enumerate() {
            self.ensure_job_not_cancelled(&job.id).await?;
            if let Some(tile) = reader.get_tile(coord).await.map_err(|error| {
                AppError::Internal(format!("could not read remote PMTiles tile: {error}"))
            })? {
                tiles.push((coord, tile));
                found_any_tiles = true;
            }
            let done = index + 1;
            if should_emit_progress(done, total_coords) {
                let progress_percent = percent_for_range(done, total_coords, 5, 80);
                let segments_done = i32::try_from(done).map_err(|error| {
                    AppError::Internal(format!("tile segment progress overflowed: {error}"))
                })?;
                self.update_job_progress(
                    &job.id,
                    "Downloading tiles",
                    progress_percent,
                    segments_done,
                    segments_total,
                )
                .await?;
                tracing::debug!(
                    job_id = %job.id,
                    chunk_id = %log_chunk_id,
                    build_key = %job.build_key,
                    progress_percent,
                    segments_done,
                    segments_total,
                    "managed map download progress"
                );
            }
        }

        if !found_any_tiles {
            tracing::warn!(
                job_id = %job.id,
                chunk_id = %log_chunk_id,
                build_key = %job.build_key,
                bounds = %format!("{min_lat:.4},{min_lon:.4} -> {max_lat:.4},{max_lon:.4}"),
                max_zoom = chunk.max_zoom,
                "managed map extract produced no tiles"
            );
            return Err(AppError::InvalidRequest(
                "selected area did not produce any tiles".to_owned(),
            ));
        }

        self.update_job_progress(
            &job.id,
            "Writing local archive",
            85,
            segments_total,
            segments_total,
        )
        .await?;
        tracing::info!(
            job_id = %job.id,
            chunk_id = %log_chunk_id,
            build_key = %job.build_key,
            tiles_found = tiles.len(),
            output_path = %relative_path,
            "writing managed PMTiles archive"
        );
        {
            let file = std::fs::File::create(&absolute_path).map_err(|error| {
                AppError::Internal(format!("could not create archive file: {error}"))
            })?;
            let mut writer = PmTilesWriter::new(remote_header.tile_type)
                .tile_compression(remote_header.tile_compression)
                .internal_compression(remote_header.internal_compression())
                .min_zoom(0)
                .max_zoom(max_zoom)
                .bounds(min_lon, min_lat, max_lon, max_lat)
                .center(center_lon, center_lat)
                .center_zoom(max_zoom)
                .metadata(&metadata)
                .create(file)
                .map_err(|error| {
                    AppError::Internal(format!("could not create PMTiles writer: {error}"))
                })?;
            for (coord, tile) in tiles {
                if cancel_flag.load(Ordering::Relaxed) {
                    let _ = std::fs::remove_file(&absolute_path);
                    return Err(AppError::Cancelled("map download was cancelled".to_owned()));
                }
                writer.add_raw_tile(coord, &tile).map_err(|error| {
                    AppError::Internal(format!("could not write PMTiles tile: {error}"))
                })?;
            }
            writer.finalize().map_err(|error| {
                AppError::Internal(format!("could not finalize PMTiles archive: {error}"))
            })?;
        }
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&absolute_path);
            return Err(AppError::Cancelled("map download was cancelled".to_owned()));
        }
        self.update_job_progress(
            &job.id,
            "Indexing archive",
            95,
            segments_total,
            segments_total,
        )
        .await?;
        let file_size_bytes = i64::try_from(
            tokio::fs::metadata(&absolute_path)
                .await
                .map_err(|error| {
                    AppError::Internal(format!("could not stat PMTiles archive: {error}"))
                })?
                .len(),
        )
        .map_err(|error| AppError::Internal(format!("archive file size was too large: {error}")))?;
        tracing::info!(
            job_id = %job.id,
            chunk_id = %log_chunk_id,
            build_key = %job.build_key,
            output_path = %relative_path,
            file_size_bytes,
            elapsed_ms = started.elapsed().as_millis(),
            "managed PMTiles archive written"
        );

        let local_reader = Arc::new(
            AsyncPmTilesReader::new_with_path(&absolute_path)
                .await
                .map_err(|error| {
                    AppError::Internal(format!("could not re-open local PMTiles archive: {error}"))
                })?,
        );
        {
            let mut readers = self.readers.write().await;
            readers.insert(chunk.id.clone(), local_reader.clone());
        }
        let header = local_reader.get_header();
        let now = Utc::now();
        let existing = map_archive::Entity::find()
            .filter(map_archive::Column::ChunkId.eq(chunk.id.clone()))
            .filter(map_archive::Column::BuildKey.eq(job.build_key.clone()))
            .one(&self.db)
            .await?;
        let archive = if let Some(existing) = existing {
            let mut model: map_archive::ActiveModel = existing.into();
            model.relative_path = Set(relative_path);
            model.tile_type = Set(tile_type_name(header.tile_type).to_owned());
            model.min_zoom = Set(i32::from(header.min_zoom));
            model.max_zoom = Set(i32::from(header.max_zoom));
            model.min_lon = Set(header.min_longitude);
            model.min_lat = Set(header.min_latitude);
            model.max_lon = Set(header.max_longitude);
            model.max_lat = Set(header.max_latitude);
            model.file_size_bytes = Set(file_size_bytes);
            model.updated_at = Set(now);
            model.update(&self.db).await?
        } else {
            map_archive::ActiveModel {
                id: Set(Uuid::new_v4().to_string()),
                chunk_id: Set(chunk.id),
                build_key: Set(job.build_key.clone()),
                relative_path: Set(relative_path),
                tile_type: Set(tile_type_name(header.tile_type).to_owned()),
                min_zoom: Set(i32::from(header.min_zoom)),
                max_zoom: Set(i32::from(header.max_zoom)),
                min_lon: Set(header.min_longitude),
                min_lat: Set(header.min_latitude),
                max_lon: Set(header.max_longitude),
                max_lat: Set(header.max_latitude),
                file_size_bytes: Set(file_size_bytes),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(&self.db)
            .await?
        };

        tracing::info!(
            job_id = %job.id,
            chunk_id = %log_chunk_id,
            build_key = %job.build_key,
            archive_id = %archive.id,
            tile_type = %tile_type_name(header.tile_type),
            min_zoom = header.min_zoom,
            max_zoom = header.max_zoom,
            elapsed_ms = started.elapsed().as_millis(),
            "managed PMTiles archive indexed"
        );

        Ok(archive.id)
    }

    async fn save_build_catalog(&self, entries: &[BuildCatalogEntry]) -> AppResult<()> {
        let now = Utc::now();
        for entry in entries {
            let existing = protomaps_build::Entity::find_by_id(entry.key.clone())
                .one(&self.db)
                .await?;
            if let Some(existing) = existing {
                let mut model: protomaps_build::ActiveModel = existing.into();
                model.version = Set(entry.version.clone());
                model.size = Set(entry.size);
                model.uploaded = Set(entry.uploaded.clone());
                model.md5_sum = Set(entry.md5sum.clone());
                model.b3_sum = Set(entry.b3sum.clone());
                model.updated_at = Set(now);
                model.update(&self.db).await?;
            } else {
                protomaps_build::ActiveModel {
                    key: Set(entry.key.clone()),
                    version: Set(entry.version.clone()),
                    size: Set(entry.size),
                    uploaded: Set(entry.uploaded.clone()),
                    md5_sum: Set(entry.md5sum.clone()),
                    b3_sum: Set(entry.b3sum.clone()),
                    created_at: Set(now),
                    updated_at: Set(now),
                }
                .insert(&self.db)
                .await?;
            }
        }
        Ok(())
    }

    async fn ensure_world_chunk(&self) -> AppResult<map_chunk::Model> {
        if let Some(existing) = map_chunk::Entity::find_by_id(WORLD_TO_6_CHUNK_ID.to_owned())
            .one(&self.db)
            .await?
        {
            return Ok(existing);
        }
        let now = Utc::now();
        map_chunk::ActiveModel {
            id: Set(WORLD_TO_6_CHUNK_ID.to_owned()),
            label: Set("World to 6".to_owned()),
            kind: Set("world".to_owned()),
            min_lon: Set(Some(-180.0)),
            min_lat: Set(Some(-MAX_MERCATOR_LAT)),
            max_lon: Set(Some(180.0)),
            max_lat: Set(Some(MAX_MERCATOR_LAT)),
            max_zoom: Set(6),
            enabled: Set(true),
            display_order: Set(1000),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&self.db)
        .await
        .map_err(Into::into)
    }

    async fn enqueue_job(
        &self,
        kind: &str,
        build_key: &str,
        chunk_id: Option<String>,
    ) -> AppResult<map_job::Model> {
        let now = Utc::now();
        let job = map_job::ActiveModel {
            id: Set(Uuid::new_v4().to_string()),
            kind: Set(kind.to_owned()),
            status: Set("queued".to_owned()),
            build_key: Set(build_key.to_owned()),
            chunk_id: Set(chunk_id),
            archive_id: Set(None),
            error_message: Set(None),
            current_step: Set("Queued".to_owned()),
            progress_percent: Set(0),
            segments_done: Set(0),
            segments_total: Set(0),
            created_at: Set(now),
            updated_at: Set(now),
            started_at: Set(None),
            finished_at: Set(None),
        }
        .insert(&self.db)
        .await?;
        self.set_cancel_flag(&job.id, false).await;
        Ok(job)
    }

    async fn update_job_progress(
        &self,
        job_id: &str,
        current_step: &str,
        progress_percent: i32,
        segments_done: i32,
        segments_total: i32,
    ) -> AppResult<()> {
        let Some(job) = map_job::Entity::find_by_id(job_id.to_owned())
            .one(&self.db)
            .await?
        else {
            return Ok(());
        };

        let now = Utc::now();
        let mut model: map_job::ActiveModel = job.into();
        model.current_step = Set(current_step.to_owned());
        model.progress_percent = Set(progress_percent.clamp(0, 100));
        model.segments_done = Set(segments_done.max(0));
        model.segments_total = Set(segments_total.max(0));
        model.updated_at = Set(now);
        model.update(&self.db).await?;
        Ok(())
    }

    async fn find_matching_area_chunk(
        &self,
        min_lon: f64,
        min_lat: f64,
        max_lon: f64,
        max_lat: f64,
        max_zoom: i32,
    ) -> AppResult<Option<map_chunk::Model>> {
        map_chunk::Entity::find()
            .filter(map_chunk::Column::Kind.eq("area"))
            .filter(map_chunk::Column::MinLon.eq(Some(min_lon)))
            .filter(map_chunk::Column::MinLat.eq(Some(min_lat)))
            .filter(map_chunk::Column::MaxLon.eq(Some(max_lon)))
            .filter(map_chunk::Column::MaxLat.eq(Some(max_lat)))
            .filter(map_chunk::Column::MaxZoom.eq(max_zoom))
            .one(&self.db)
            .await
            .map_err(Into::into)
    }

    async fn ensure_chunk_ready_for_enqueue(
        &self,
        build_key: &str,
        chunk_id: &str,
    ) -> AppResult<()> {
        if self.archive_exists_for_chunk(build_key, chunk_id).await? {
            return Err(AppError::Conflict(
                "map segment is already downloaded for this build".to_owned(),
            ));
        }
        if let Some(job) = self.find_active_job_for_chunk(build_key, chunk_id).await? {
            return Err(AppError::Conflict(format!(
                "map job {} is already active for this segment",
                job.id
            )));
        }
        Ok(())
    }

    async fn archive_exists_for_chunk(&self, build_key: &str, chunk_id: &str) -> AppResult<bool> {
        Ok(map_archive::Entity::find()
            .filter(map_archive::Column::BuildKey.eq(build_key.to_owned()))
            .filter(map_archive::Column::ChunkId.eq(chunk_id.to_owned()))
            .one(&self.db)
            .await?
            .is_some())
    }

    async fn find_active_job_for_chunk(
        &self,
        build_key: &str,
        chunk_id: &str,
    ) -> AppResult<Option<map_job::Model>> {
        map_job::Entity::find()
            .filter(map_job::Column::BuildKey.eq(build_key.to_owned()))
            .filter(map_job::Column::ChunkId.eq(chunk_id.to_owned()))
            .filter(map_job::Column::Status.is_in(ACTIVE_JOB_STATUSES))
            .order_by_desc(map_job::Column::CreatedAt)
            .one(&self.db)
            .await
            .map_err(Into::into)
    }

    async fn ensure_job_not_cancelled(&self, job_id: &str) -> AppResult<()> {
        if self.is_cancel_requested(job_id).await {
            return Err(AppError::Cancelled("map download was cancelled".to_owned()));
        }
        Ok(())
    }

    async fn is_cancel_requested(&self, job_id: &str) -> bool {
        self.cancel_flag(job_id).await.load(Ordering::Relaxed)
    }

    async fn set_cancel_flag(&self, job_id: &str, cancelled: bool) {
        let flag = self.cancel_flag(job_id).await;
        flag.store(cancelled, Ordering::Relaxed);
    }

    async fn clear_cancel_flag(&self, job_id: &str) {
        self.cancel_flags.write().await.remove(job_id);
    }

    async fn cancel_flag(&self, job_id: &str) -> Arc<AtomicBool> {
        let mut flags = self.cancel_flags.write().await;
        flags
            .entry(job_id.to_owned())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    async fn ensure_selected_build_key(&self, build_key: &str) -> AppResult<()> {
        if self.selected_build_key().await?.is_none() {
            self.set_selected_build_key(build_key).await?;
        }
        Ok(())
    }

    async fn selected_build_key(&self) -> AppResult<Option<String>> {
        Ok(
            metadata::Entity::find_by_id(SELECTED_BUILD_METADATA_KEY.to_owned())
                .one(&self.db)
                .await?
                .map(|model| model.value),
        )
    }

    async fn set_selected_build_key(&self, build_key: &str) -> AppResult<()> {
        if let Some(existing) = metadata::Entity::find_by_id(SELECTED_BUILD_METADATA_KEY.to_owned())
            .one(&self.db)
            .await?
        {
            let mut model: metadata::ActiveModel = existing.into();
            model.value = Set(build_key.to_owned());
            model.update(&self.db).await?;
        } else {
            metadata::ActiveModel {
                key: Set(SELECTED_BUILD_METADATA_KEY.to_owned()),
                value: Set(build_key.to_owned()),
            }
            .insert(&self.db)
            .await?;
        }
        Ok(())
    }

    async fn next_display_order(&self) -> AppResult<i32> {
        let count = map_chunk::Entity::find().count(&self.db).await?;
        i32::try_from(count)
            .map(|value| value + 1)
            .map_err(|error| AppError::Internal(format!("too many map chunks to order: {error}")))
    }

    async fn active_layers_for_selected_build(&self) -> AppResult<Vec<ManagedLayer>> {
        let Some(selected_build_key) = self.selected_build_key().await? else {
            return Ok(Vec::new());
        };
        let chunks = map_chunk::Entity::find()
            .filter(map_chunk::Column::Enabled.eq(true))
            .all(&self.db)
            .await?;
        if chunks.is_empty() {
            return Ok(Vec::new());
        }
        let chunk_by_id = chunks
            .into_iter()
            .map(|chunk| (chunk.id.clone(), chunk))
            .collect::<HashMap<_, _>>();
        let chunk_ids = chunk_by_id.keys().cloned().collect::<Vec<_>>();
        let archives = map_archive::Entity::find()
            .filter(map_archive::Column::BuildKey.eq(selected_build_key))
            .filter(map_archive::Column::ChunkId.is_in(chunk_ids))
            .all(&self.db)
            .await?;

        let mut layers = archives
            .into_iter()
            .filter_map(|archive| {
                chunk_by_id
                    .get(&archive.chunk_id)
                    .cloned()
                    .map(|chunk| ManagedLayer { chunk, archive })
            })
            .collect::<Vec<_>>();
        layers.sort_by(|left, right| {
            chunk_area(&left.chunk)
                .partial_cmp(&chunk_area(&right.chunk))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.chunk.display_order.cmp(&right.chunk.display_order))
        });
        Ok(layers)
    }

    async fn reader_for_archive(
        &self,
        archive: &map_archive::Model,
    ) -> AppResult<Arc<AsyncPmTilesReader<MmapBackend>>> {
        {
            let readers = self.readers.read().await;
            if let Some(reader) = readers.get(&archive.id) {
                return Ok(reader.clone());
            }
        }

        let path = self.config.managed_maps_dir.join(&archive.relative_path);
        let reader = Arc::new(
            AsyncPmTilesReader::new_with_path(path)
                .await
                .map_err(|error| {
                    AppError::Internal(format!("could not open managed PMTiles archive: {error}"))
                })?,
        );
        let mut readers = self.readers.write().await;
        readers.insert(archive.id.clone(), reader.clone());
        Ok(reader)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActiveLayerUpdate {
    pub chunk_id: String,
    pub enabled: bool,
    pub display_order: i32,
}

fn rewrite_style_sources(mut style: serde_json::Value) -> serde_json::Value {
    if let Some(sources) = style
        .get_mut("sources")
        .and_then(serde_json::Value::as_object_mut)
    {
        for source in sources.values_mut() {
            *source = serde_json::json!({
                "type": "vector",
                "url": "/api/basemap/tilejson.json"
            });
        }
    }
    style
}

fn tile_type_name(tile_type: TileType) -> &'static str {
    match tile_type {
        TileType::Unknown => "unknown",
        TileType::Mvt => "mvt",
        TileType::Png => "png",
        TileType::Jpeg => "jpeg",
        TileType::Webp => "webp",
        TileType::Avif => "avif",
        TileType::Mlt => "mlt",
    }
}

fn archive_filename(chunk_id: &str, build_key: &str) -> String {
    let sanitized_build = build_key.replace('/', "-");
    format!("{chunk_id}-{sanitized_build}")
}

fn bounds_for_chunk(chunk: &map_chunk::Model) -> (f64, f64, f64, f64) {
    if chunk.id == WORLD_TO_6_CHUNK_ID {
        (-180.0, -MAX_MERCATOR_LAT, 180.0, MAX_MERCATOR_LAT)
    } else {
        (
            chunk.min_lon.unwrap_or(-180.0),
            chunk.min_lat.unwrap_or(-MAX_MERCATOR_LAT),
            chunk.max_lon.unwrap_or(180.0),
            chunk.max_lat.unwrap_or(MAX_MERCATOR_LAT),
        )
    }
}

fn coords_for_chunk(chunk: &map_chunk::Model) -> AppResult<Vec<TileCoord>> {
    let max_zoom = u8::try_from(chunk.max_zoom).map_err(|error| {
        AppError::Internal(format!("invalid max zoom stored in map chunk: {error}"))
    })?;
    let (min_lon, min_lat, max_lon, max_lat) = bounds_for_chunk(chunk);
    let mut coords = Vec::new();
    for z in 0..=max_zoom {
        let tiles_per_axis = 1_u32 << z;
        let (min_x, max_x, min_y, max_y) = if chunk.id == WORLD_TO_6_CHUNK_ID {
            (0, tiles_per_axis - 1, 0, tiles_per_axis - 1)
        } else {
            tile_range_for_bbox(min_lon, min_lat, max_lon, max_lat, z)
        };
        for x in min_x..=max_x {
            for y in min_y..=max_y {
                coords.push(TileCoord::new(z, x, y).map_err(|error| {
                    AppError::Internal(format!("invalid generated tile coordinate: {error}"))
                })?);
            }
        }
    }
    coords.sort_by_key(|coord| TileId::from(*coord));
    coords.dedup();
    Ok(coords)
}

fn tile_range_for_bbox(
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
    z: u8,
) -> (u32, u32, u32, u32) {
    let tiles = f64::from(1_u32 << z);
    let min_x = lon_to_tile_x(min_lon, tiles)
        .floor()
        .clamp(0.0, tiles - 1.0) as u32;
    let max_x = (lon_to_tile_x(max_lon, tiles).ceil() - 1.0).clamp(0.0, tiles - 1.0) as u32;
    let min_y = lat_to_tile_y(max_lat, tiles)
        .floor()
        .clamp(0.0, tiles - 1.0) as u32;
    let max_y = (lat_to_tile_y(min_lat, tiles).ceil() - 1.0).clamp(0.0, tiles - 1.0) as u32;
    (min_x, max_x, min_y, max_y)
}

fn lon_to_tile_x(lon: f64, tiles: f64) -> f64 {
    ((lon.clamp(-180.0, 180.0) + 180.0) / 360.0) * tiles
}

fn lat_to_tile_y(lat: f64, tiles: f64) -> f64 {
    let clamped = lat.clamp(-MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
    let latitude_radians = clamped.to_radians();
    let projected = (latitude_radians.tan() + latitude_radians.cos().recip()).ln();
    ((1.0 - (projected / std::f64::consts::PI)) / 2.0) * tiles
}

fn validate_bbox(min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64) -> AppResult<()> {
    if min_lon >= max_lon || min_lat >= max_lat {
        return Err(AppError::InvalidRequest(
            "bounding box must have increasing min/max coordinates".to_owned(),
        ));
    }
    if min_lon < -180.0
        || max_lon > 180.0
        || min_lat < -MAX_MERCATOR_LAT
        || max_lat > MAX_MERCATOR_LAT
    {
        return Err(AppError::InvalidRequest(
            "bounding box is outside Web Mercator limits".to_owned(),
        ));
    }
    Ok(())
}

fn chunk_area(chunk: &map_chunk::Model) -> f64 {
    let (min_lon, min_lat, max_lon, max_lat) = bounds_for_chunk(chunk);
    (max_lon - min_lon).abs() * (max_lat - min_lat).abs()
}

fn union_bounds<I>(bounds: I) -> [f64; 4]
where
    I: IntoIterator<Item = (f64, f64, f64, f64)>,
{
    let mut min_lon: f64 = 180.0;
    let mut min_lat: f64 = MAX_MERCATOR_LAT;
    let mut max_lon: f64 = -180.0;
    let mut max_lat: f64 = -MAX_MERCATOR_LAT;
    for (current_min_lon, current_min_lat, current_max_lon, current_max_lat) in bounds {
        min_lon = min_lon.min(current_min_lon);
        min_lat = min_lat.min(current_min_lat);
        max_lon = max_lon.max(current_max_lon);
        max_lat = max_lat.max(current_max_lat);
    }
    [min_lon, min_lat, max_lon, max_lat]
}

fn should_emit_progress(done: usize, total: usize) -> bool {
    done == total || done <= 10 || done % 25 == 0
}

fn percent_for_range(done: usize, total: usize, start: i32, end: i32) -> i32 {
    if total == 0 {
        return start;
    }
    let span = end - start;
    start + ((done as f64 / total as f64) * f64::from(span)).round() as i32
}

impl From<protomaps_build::Model> for BuildRecord {
    fn from(model: protomaps_build::Model) -> Self {
        Self {
            key: model.key,
            version: model.version,
            size: model.size,
            uploaded: model.uploaded,
            md5_sum: model.md5_sum,
            b3_sum: model.b3_sum,
        }
    }
}

impl From<map_archive::Model> for ArchiveRecord {
    fn from(model: map_archive::Model) -> Self {
        Self {
            id: model.id,
            build_key: model.build_key,
            relative_path: model.relative_path,
            tile_type: model.tile_type,
            min_zoom: model.min_zoom,
            max_zoom: model.max_zoom,
            min_lon: model.min_lon,
            min_lat: model.min_lat,
            max_lon: model.max_lon,
            max_lat: model.max_lat,
            file_size_bytes: model.file_size_bytes,
        }
    }
}

impl From<map_job::Model> for JobRecord {
    fn from(model: map_job::Model) -> Self {
        Self {
            id: model.id,
            kind: model.kind,
            status: model.status,
            build_key: model.build_key,
            chunk_id: model.chunk_id,
            archive_id: model.archive_id,
            error_message: model.error_message,
            current_step: model.current_step,
            progress_percent: model.progress_percent,
            segments_done: model.segments_done,
            segments_total: model.segments_total,
            created_at: model.created_at,
            updated_at: model.updated_at,
            started_at: model.started_at,
            finished_at: model.finished_at,
        }
    }
}

pub fn derive_managed_maps_dir(_database_url: &str) -> Option<PathBuf> {
    Some(PathBuf::from("maps"))
}
