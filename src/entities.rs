use sea_orm::entity::prelude::*;

pub mod metadata {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
    #[sea_orm(table_name = "metadata")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub key: String,
        pub value: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod collection {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "collections")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub owner_id: String,
        pub name: String,
        pub kind: String,
        pub starts_at: Option<DateTimeUtc>,
        pub ends_at: Option<DateTimeUtc>,
        pub is_public: bool,
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod place {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "places")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub owner_id: String,
        pub name: String,
        pub category: Option<String>,
        pub notes: Option<String>,
        pub latitude: f64,
        pub longitude: f64,
        pub visit_start: Option<DateTimeUtc>,
        pub visit_end: Option<DateTimeUtc>,
        pub related_track_id: Option<String>,
        pub is_public: bool,
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod track {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "tracks")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub owner_id: String,
        pub title: Option<String>,
        pub original_filename: Option<String>,
        pub gpx_metadata_json: Option<String>,
        pub notes: Option<String>,
        pub geometry_json: String,
        pub min_lat: f64,
        pub min_lon: f64,
        pub max_lat: f64,
        pub max_lon: f64,
        pub distance_m: Option<f64>,
        pub start_time: Option<DateTimeUtc>,
        pub end_time: Option<DateTimeUtc>,
        pub is_public: bool,
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod membership {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "memberships")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
        pub object_type: String,
        pub object_id: String,
        pub collection_id: String,
        pub created_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod tag {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "tags")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
        pub owner_id: String,
        pub name: String,
        pub created_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod object_tag {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "object_tags")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
        pub object_type: String,
        pub object_id: String,
        pub tag_id: i32,
        pub created_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod protomaps_build {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "protomaps_builds")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub key: String,
        pub version: Option<String>,
        pub size: i64,
        pub uploaded: String,
        pub md5_sum: Option<String>,
        pub b3_sum: Option<String>,
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod map_chunk {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "map_chunk_defs")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
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
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod map_archive {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "map_archives")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub chunk_id: String,
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
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod map_job {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "map_jobs")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
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
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
        pub started_at: Option<DateTimeUtc>,
        pub finished_at: Option<DateTimeUtc>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
