use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use migration::MigratorTrait;
use pmtiles::{AsyncPmTilesReader, MmapBackend};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectOptions, Database, DatabaseConnection,
    EntityTrait, QueryFilter,
};
use uuid::Uuid;

use crate::{
    entities::metadata,
    error::{AppError, AppResult},
};

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub database_url: String,
    pub listen_addr: SocketAddr,
    pub pmtiles_path: Option<PathBuf>,
    pub pmtiles_style_path: Option<PathBuf>,
}

impl AppConfig {
    pub fn for_tests() -> Self {
        Self {
            database_url: "sqlite::memory:".to_owned(),
            listen_addr: "127.0.0.1:0"
                .parse()
                .expect("test listen address should parse"),
            pmtiles_path: None,
            pmtiles_style_path: None,
        }
    }
}

#[derive(Clone)]
pub struct AppContext {
    db: DatabaseConnection,
    owner_id: String,
    config: AppConfig,
    pmtiles_reader: Option<Arc<AsyncPmTilesReader<MmapBackend>>>,
}

impl AppContext {
    pub async fn bootstrap(config: AppConfig) -> AppResult<Self> {
        let mut options = ConnectOptions::new(config.database_url.clone());
        options.sqlx_logging(false);
        options.max_connections(1);

        let db = Database::connect(options).await?;
        migration::Migrator::up(&db, None)
            .await
            .map_err(|error| AppError::Internal(format!("migration failed: {error}")))?;

        let owner_id = ensure_owner_id(&db).await?;
        let pmtiles_reader = match &config.pmtiles_path {
            Some(path) => Some(Arc::new(
                AsyncPmTilesReader::new_with_path(path)
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!("could not open PMTiles archive: {error}"))
                    })?,
            )),
            None => None,
        };

        Ok(Self {
            db,
            owner_id,
            config,
            pmtiles_reader,
        })
    }

    pub fn db(&self) -> &DatabaseConnection {
        &self.db
    }

    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }

    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    pub fn pmtiles_reader(&self) -> Option<&Arc<AsyncPmTilesReader<MmapBackend>>> {
        self.pmtiles_reader.as_ref()
    }
}

async fn ensure_owner_id(db: &DatabaseConnection) -> AppResult<String> {
    if let Some(existing) = metadata::Entity::find_by_id("owner_id".to_owned())
        .one(db)
        .await?
    {
        return Ok(existing.value);
    }

    let owner_id = Uuid::new_v4().to_string();
    metadata::ActiveModel {
        key: Set("owner_id".to_owned()),
        value: Set(owner_id.clone()),
    }
    .insert(db)
    .await?;

    let saved = metadata::Entity::find()
        .filter(metadata::Column::Key.eq("owner_id"))
        .one(db)
        .await?
        .ok_or_else(|| {
            AppError::Internal("owner_id metadata should exist after insert".to_owned())
        })?;

    Ok(saved.value)
}
