use std::sync::Arc;
use std::{io::BufReader, io::Cursor};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use geojson::Geometry;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition, EntityTrait, QueryFilter,
    QuerySelect, QueryTrait, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;
use uuid::Uuid;

use crate::{
    app::AppContext,
    entities::{collection, membership, object_tag, place, tag, track},
    error::{AppError, AppResult, ErrorBody},
    maps::{
        ActiveLayerUpdate, ArchiveRecord, AreaExtractSpec, BuildCatalogResponse, BuildRecord,
        ChunkRecord, EnqueuedJobResponse, JobListResponse, JobRecord, LocalMapsResponse,
        RebuildChunksResponse,
    },
};

const MAX_GPX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
pub fn build_router(context: Arc<AppContext>) -> Router {
    Router::new()
        .route("/api/collections", post(create_collection))
        .route("/api/collections", get(list_collections))
        .route("/api/places", post(create_place))
        .route(
            "/api/places/{place_id}",
            get(get_place).patch(update_place).delete(delete_place),
        )
        .route(
            "/api/tracks/import",
            post(import_tracks).layer(DefaultBodyLimit::max(MAX_GPX_UPLOAD_BYTES)),
        )
        .route(
            "/api/tracks/{track_id}",
            get(get_track).patch(update_track).delete(delete_track),
        )
        .route("/api/map-objects", get(list_map_objects))
        .route("/api/search", get(search_map_objects))
        .merge(crate::maps_api::build_router())
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .with_state(context)
}

#[derive(OpenApi)]
#[openapi(
    paths(
        create_collection,
        list_collections,
        create_place,
        get_place,
        update_place,
        delete_place,
        import_tracks,
        list_map_objects,
        search_map_objects,
        get_track,
        update_track,
        delete_track,
        crate::maps_api::get_builds,
        crate::maps_api::get_local_maps,
        crate::maps_api::get_jobs,
        crate::maps_api::post_cancel_job,
        crate::maps_api::post_world_to_6,
        crate::maps_api::post_area_extract,
        crate::maps_api::post_active_layers,
        crate::maps_api::post_rebuild_chunks,
        crate::maps_api::get_basemap_config,
        crate::maps_api::get_basemap_style,
        crate::maps_api::get_basemap_tilejson,
        crate::maps_api::get_basemap_font,
        crate::maps_api::get_basemap_sprite_json,
        crate::maps_api::get_basemap_sprite_png,
        crate::maps_api::get_basemap_sprite_json_hidpi,
        crate::maps_api::get_basemap_sprite_png_hidpi,
        crate::maps_api::get_missing_basemap_tiles,
        crate::maps_api::get_basemap_tile
    ),
    components(schemas(
        ActiveLayerUpdate,
        AreaExtractSpec,
        ArchiveRecord,
        BuildCatalogResponse,
        BuildRecord,
        ChunkRecord,
        CollectionResponse,
        CreateCollectionRequest,
        CreatePlaceRequest,
        EnqueuedJobResponse,
        ErrorBody,
        ImportTracksResponse,
        JobListResponse,
        JobRecord,
        LocalMapsResponse,
        MapObjectsQuery,
        MapObjectsResponse,
        PlaceResponse,
        RebuildChunksResponse,
        SearchQuery,
        TrackResponse,
        UpdatePlaceRequest,
        UpdateTrackRequest,
        crate::maps_api::ActiveLayersRequest,
        crate::maps_api::AreaExtractRequest,
        crate::maps_api::BasemapConfigResponse,
        crate::maps_api::MissingTilesResponse,
        crate::maps_api::RebuildChunksRequest,
        crate::maps_api::WorldTo6Request
    )),
    tags((name = "map-travel", description = "Map Travel API"))
)]
struct ApiDoc;

#[derive(Debug, Deserialize, ToSchema)]
struct CreateCollectionRequest {
    name: String,
    kind: String,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, ToSchema)]
struct CollectionResponse {
    id: String,
    name: String,
    kind: String,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
    is_public: bool,
}

#[utoipa::path(
    post,
    path = "/api/collections",
    request_body = CreateCollectionRequest,
    responses(
        (status = 201, description = "Collection created", body = CollectionResponse),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn create_collection(
    State(context): State<Arc<AppContext>>,
    Json(request): Json<CreateCollectionRequest>,
) -> AppResult<(StatusCode, Json<CollectionResponse>)> {
    validate_collection_kind(&request.kind)?;

    let now = Utc::now();
    let model = collection::ActiveModel {
        id: Set(Uuid::new_v4().to_string()),
        owner_id: Set(context.owner_id().to_owned()),
        name: Set(request.name),
        kind: Set(request.kind),
        starts_at: Set(request.starts_at),
        ends_at: Set(request.ends_at),
        is_public: Set(true),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(context.db())
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(CollectionResponse {
            id: model.id,
            name: model.name,
            kind: model.kind,
            starts_at: model.starts_at,
            ends_at: model.ends_at,
            is_public: model.is_public,
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/api/collections",
    responses(
        (status = 200, description = "Collections", body = [CollectionResponse]),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn list_collections(
    State(context): State<Arc<AppContext>>,
) -> AppResult<Json<Vec<CollectionResponse>>> {
    let collections = collection::Entity::find()
        .all(context.db())
        .await?
        .into_iter()
        .map(|model| CollectionResponse {
            id: model.id,
            name: model.name,
            kind: model.kind,
            starts_at: model.starts_at,
            ends_at: model.ends_at,
            is_public: model.is_public,
        })
        .collect();

    Ok(Json(collections))
}

#[derive(Debug, Deserialize, ToSchema)]
struct CreatePlaceRequest {
    name: String,
    category: Option<String>,
    notes: Option<String>,
    latitude: f64,
    longitude: f64,
    visit_start: Option<DateTime<Utc>>,
    visit_end: Option<DateTime<Utc>>,
    collection_ids: Vec<String>,
    tag_names: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
struct PlaceResponse {
    id: String,
    name: String,
    category: Option<String>,
    notes: Option<String>,
    latitude: f64,
    longitude: f64,
    visit_start: Option<DateTime<Utc>>,
    visit_end: Option<DateTime<Utc>>,
    is_public: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
struct UpdatePlaceRequest {
    name: String,
    category: Option<String>,
    notes: Option<String>,
    visit_start: Option<DateTime<Utc>>,
    visit_end: Option<DateTime<Utc>>,
}

#[utoipa::path(
    post,
    path = "/api/places",
    request_body = CreatePlaceRequest,
    responses(
        (status = 201, description = "Place created", body = PlaceResponse),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn create_place(
    State(context): State<Arc<AppContext>>,
    Json(request): Json<CreatePlaceRequest>,
) -> AppResult<(StatusCode, Json<PlaceResponse>)> {
    let now = Utc::now();
    let place_id = Uuid::new_v4().to_string();

    let model = place::ActiveModel {
        id: Set(place_id.clone()),
        owner_id: Set(context.owner_id().to_owned()),
        name: Set(request.name),
        category: Set(request.category),
        notes: Set(request.notes),
        latitude: Set(request.latitude),
        longitude: Set(request.longitude),
        visit_start: Set(request.visit_start),
        visit_end: Set(request.visit_end),
        related_track_id: Set(None),
        is_public: Set(true),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(context.db())
    .await?;

    for collection_id in request.collection_ids {
        membership::ActiveModel {
            id: Default::default(),
            object_type: Set("place".to_owned()),
            object_id: Set(place_id.clone()),
            collection_id: Set(collection_id),
            created_at: Set(now),
        }
        .insert(context.db())
        .await?;
    }

    for tag_name in request.tag_names {
        let tag_model = match tag::Entity::find()
            .filter(tag::Column::OwnerId.eq(context.owner_id().to_owned()))
            .filter(tag::Column::Name.eq(tag_name.clone()))
            .one(context.db())
            .await?
        {
            Some(existing) => existing,
            None => {
                tag::ActiveModel {
                    id: Default::default(),
                    owner_id: Set(context.owner_id().to_owned()),
                    name: Set(tag_name.clone()),
                    created_at: Set(now),
                }
                .insert(context.db())
                .await?
            }
        };

        object_tag::ActiveModel {
            id: Default::default(),
            object_type: Set("place".to_owned()),
            object_id: Set(place_id.clone()),
            tag_id: Set(tag_model.id),
            created_at: Set(now),
        }
        .insert(context.db())
        .await?;
    }

    Ok((
        StatusCode::CREATED,
        Json(PlaceResponse {
            id: model.id,
            name: model.name,
            category: model.category,
            notes: model.notes,
            latitude: model.latitude,
            longitude: model.longitude,
            visit_start: model.visit_start,
            visit_end: model.visit_end,
            is_public: model.is_public,
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/api/places/{place_id}",
    params(("place_id" = String, Path, description = "Place ID")),
    responses(
        (status = 200, description = "Place found", body = PlaceResponse),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn get_place(
    State(context): State<Arc<AppContext>>,
    Path(place_id): Path<String>,
) -> AppResult<Json<PlaceResponse>> {
    let model = place::Entity::find_by_id(place_id)
        .one(context.db())
        .await?
        .ok_or_else(|| AppError::InvalidRequest("place does not exist".to_owned()))?;

    Ok(Json(PlaceResponse {
        id: model.id,
        name: model.name,
        category: model.category,
        notes: model.notes,
        latitude: model.latitude,
        longitude: model.longitude,
        visit_start: model.visit_start,
        visit_end: model.visit_end,
        is_public: model.is_public,
    }))
}

#[utoipa::path(
    patch,
    path = "/api/places/{place_id}",
    params(("place_id" = String, Path, description = "Place ID")),
    request_body = UpdatePlaceRequest,
    responses(
        (status = 200, description = "Place updated", body = PlaceResponse),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn update_place(
    State(context): State<Arc<AppContext>>,
    Path(place_id): Path<String>,
    Json(request): Json<UpdatePlaceRequest>,
) -> AppResult<Json<PlaceResponse>> {
    let existing = place::Entity::find_by_id(place_id)
        .one(context.db())
        .await?
        .ok_or_else(|| AppError::InvalidRequest("place does not exist".to_owned()))?;
    let trimmed_name = request.name.trim();
    if trimmed_name.is_empty() {
        return Err(AppError::InvalidRequest(
            "place name must not be empty".to_owned(),
        ));
    }

    let now = Utc::now();
    let mut model: place::ActiveModel = existing.into();
    model.name = Set(trimmed_name.to_owned());
    model.category = Set(request
        .category
        .and_then(|value| trim_optional_string(&value)));
    model.notes = Set(request.notes.and_then(|value| trim_optional_string(&value)));
    model.visit_start = Set(request.visit_start);
    model.visit_end = Set(request.visit_end);
    model.updated_at = Set(now);
    let updated = model.update(context.db()).await?;

    Ok(Json(PlaceResponse {
        id: updated.id,
        name: updated.name,
        category: updated.category,
        notes: updated.notes,
        latitude: updated.latitude,
        longitude: updated.longitude,
        visit_start: updated.visit_start,
        visit_end: updated.visit_end,
        is_public: updated.is_public,
    }))
}

#[utoipa::path(
    delete,
    path = "/api/places/{place_id}",
    params(("place_id" = String, Path, description = "Place ID")),
    responses(
        (status = 204, description = "Place deleted"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn delete_place(
    State(context): State<Arc<AppContext>>,
    Path(place_id): Path<String>,
) -> AppResult<StatusCode> {
    let transaction = context.db().begin().await?;

    place::Entity::find_by_id(place_id.clone())
        .one(&transaction)
        .await?
        .ok_or_else(|| AppError::InvalidRequest("place does not exist".to_owned()))?;

    delete_object_links(&transaction, "place", &place_id).await?;
    place::Entity::delete_by_id(place_id)
        .exec(&transaction)
        .await?;
    transaction.commit().await?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize, ToSchema)]
struct ImportTracksResponse {
    tracks: Vec<TrackResponse>,
}

#[utoipa::path(
    post,
    path = "/api/tracks/import",
    request_body(content = String, content_type = "multipart/form-data"),
    responses(
        (status = 201, description = "Tracks imported", body = ImportTracksResponse),
        (status = 400, description = "Invalid upload", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn import_tracks(
    State(context): State<Arc<AppContext>>,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<ImportTracksResponse>)> {
    let mut file_bytes = None;
    let mut original_filename = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::InvalidRequest(format!("invalid multipart upload: {error}")))?
    {
        if field.name() == Some("file") {
            original_filename = field
                .file_name()
                .and_then(uploaded_filename_basename)
                .map(str::to_owned);
            file_bytes = Some(
                field
                    .bytes()
                    .await
                    .map_err(|error| {
                        AppError::InvalidRequest(format!(
                            "could not read uploaded GPX file: {error}"
                        ))
                    })?
                    .to_vec(),
            );
            break;
        }
    }

    let file_bytes = file_bytes.ok_or_else(|| {
        AppError::InvalidRequest("GPX upload must include a `file` form field".to_owned())
    })?;
    let gpx = gpx::read(BufReader::new(Cursor::new(file_bytes)))
        .map_err(|error| AppError::InvalidRequest(format!("GPX parsing failed: {error}")))?;

    if gpx.tracks.is_empty() {
        return Err(AppError::InvalidRequest(
            "GPX file did not contain any tracks".to_owned(),
        ));
    }

    let now = Utc::now();
    let mut imported = Vec::new();

    for parsed_track in gpx.tracks {
        let summary = summarize_gpx_track(&parsed_track)?;
        let created = track::ActiveModel {
            id: Set(Uuid::new_v4().to_string()),
            owner_id: Set(context.owner_id().to_owned()),
            title: Set(parsed_track.name.clone()),
            original_filename: Set(original_filename.clone()),
            notes: Set(parsed_track.description.clone()),
            geometry_json: Set(summary.geometry_json),
            min_lat: Set(summary.min_lat),
            min_lon: Set(summary.min_lon),
            max_lat: Set(summary.max_lat),
            max_lon: Set(summary.max_lon),
            distance_m: Set(Some(summary.distance_m)),
            start_time: Set(summary.start_time),
            end_time: Set(summary.end_time),
            is_public: Set(true),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(context.db())
        .await?;

        imported.push(TrackResponse::from_model(created));
    }

    Ok((
        StatusCode::CREATED,
        Json(ImportTracksResponse { tracks: imported }),
    ))
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
struct MapObjectsQuery {
    min_lat: f64,
    min_lon: f64,
    max_lat: f64,
    max_lon: f64,
    object_type: Option<String>,
    collection_id: Option<String>,
    tag: Option<String>,
    starts_after: Option<DateTime<Utc>>,
    ends_before: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
struct SearchQuery {
    query: String,
}

#[derive(Debug, Serialize, ToSchema)]
struct MapObjectsResponse {
    tracks: Vec<TrackResponse>,
    places: Vec<PlaceResponse>,
}

#[derive(Debug, Serialize, ToSchema)]
struct TrackResponse {
    id: String,
    title: Option<String>,
    original_filename: Option<String>,
    notes: Option<String>,
    geometry_json: String,
    min_lat: f64,
    min_lon: f64,
    max_lat: f64,
    max_lon: f64,
    distance_m: Option<f64>,
    start_time: Option<DateTime<Utc>>,
    end_time: Option<DateTime<Utc>>,
}

impl TrackResponse {
    fn from_model(model: track::Model) -> Self {
        Self {
            id: model.id,
            title: model.title,
            original_filename: model.original_filename,
            notes: model.notes,
            geometry_json: model.geometry_json,
            min_lat: model.min_lat,
            min_lon: model.min_lon,
            max_lat: model.max_lat,
            max_lon: model.max_lon,
            distance_m: model.distance_m,
            start_time: model.start_time,
            end_time: model.end_time,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
struct UpdateTrackRequest {
    title: Option<String>,
    notes: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/map-objects",
    params(MapObjectsQuery),
    responses(
        (status = 200, description = "Map objects in bounds", body = MapObjectsResponse),
        (status = 400, description = "Invalid query", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn list_map_objects(
    State(context): State<Arc<AppContext>>,
    Query(query): Query<MapObjectsQuery>,
) -> AppResult<Json<MapObjectsResponse>> {
    let place_condition = place_condition(&query)?;
    let track_condition = track_condition(&query)?;

    let places = if query.object_type.as_deref() == Some("track") {
        Vec::new()
    } else {
        place::Entity::find()
            .filter(place_condition)
            .all(context.db())
            .await?
            .into_iter()
            .map(|model| PlaceResponse {
                id: model.id,
                name: model.name,
                category: model.category,
                notes: model.notes,
                latitude: model.latitude,
                longitude: model.longitude,
                visit_start: model.visit_start,
                visit_end: model.visit_end,
                is_public: model.is_public,
            })
            .collect()
    };

    let tracks = if query.object_type.as_deref() == Some("place") {
        Vec::new()
    } else {
        track::Entity::find()
            .filter(track_condition)
            .all(context.db())
            .await?
            .into_iter()
            .map(TrackResponse::from_model)
            .collect()
    };

    Ok(Json(MapObjectsResponse { tracks, places }))
}

#[utoipa::path(
    get,
    path = "/api/search",
    params(SearchQuery),
    responses(
        (status = 200, description = "Global search results", body = MapObjectsResponse),
        (status = 400, description = "Invalid query", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn search_map_objects(
    State(context): State<Arc<AppContext>>,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<MapObjectsResponse>> {
    let search = query.query.trim();
    if search.is_empty() {
        return Err(AppError::InvalidRequest(
            "search query must not be empty".to_owned(),
        ));
    }

    let places = place::Entity::find()
        .filter(search_place_condition(search))
        .all(context.db())
        .await?
        .into_iter()
        .map(|model| PlaceResponse {
            id: model.id,
            name: model.name,
            category: model.category,
            notes: model.notes,
            latitude: model.latitude,
            longitude: model.longitude,
            visit_start: model.visit_start,
            visit_end: model.visit_end,
            is_public: model.is_public,
        })
        .collect();

    let tracks = track::Entity::find()
        .filter(search_track_condition(search))
        .all(context.db())
        .await?
        .into_iter()
        .map(TrackResponse::from_model)
        .collect();

    Ok(Json(MapObjectsResponse { tracks, places }))
}

#[utoipa::path(
    get,
    path = "/api/tracks/{track_id}",
    params(("track_id" = String, Path, description = "Track ID")),
    responses(
        (status = 200, description = "Track found", body = TrackResponse),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn get_track(
    State(context): State<Arc<AppContext>>,
    Path(track_id): Path<String>,
) -> AppResult<Json<TrackResponse>> {
    let model = track::Entity::find_by_id(track_id)
        .one(context.db())
        .await?
        .ok_or_else(|| AppError::InvalidRequest("track does not exist".to_owned()))?;

    Ok(Json(TrackResponse::from_model(model)))
}

#[utoipa::path(
    patch,
    path = "/api/tracks/{track_id}",
    params(("track_id" = String, Path, description = "Track ID")),
    request_body = UpdateTrackRequest,
    responses(
        (status = 200, description = "Track updated", body = TrackResponse),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn update_track(
    State(context): State<Arc<AppContext>>,
    Path(track_id): Path<String>,
    Json(request): Json<UpdateTrackRequest>,
) -> AppResult<Json<TrackResponse>> {
    let existing = track::Entity::find_by_id(track_id)
        .one(context.db())
        .await?
        .ok_or_else(|| AppError::InvalidRequest("track does not exist".to_owned()))?;

    let now = Utc::now();
    let mut model: track::ActiveModel = existing.into();
    model.title = Set(request.title.and_then(|value| trim_optional_string(&value)));
    model.notes = Set(request.notes.and_then(|value| trim_optional_string(&value)));
    model.updated_at = Set(now);
    let updated = model.update(context.db()).await?;

    Ok(Json(TrackResponse::from_model(updated)))
}

#[utoipa::path(
    delete,
    path = "/api/tracks/{track_id}",
    params(("track_id" = String, Path, description = "Track ID")),
    responses(
        (status = 204, description = "Track deleted"),
        (status = 400, description = "Invalid request", body = ErrorBody),
        (status = 500, description = "Internal error", body = ErrorBody)
    )
)]
async fn delete_track(
    State(context): State<Arc<AppContext>>,
    Path(track_id): Path<String>,
) -> AppResult<StatusCode> {
    let transaction = context.db().begin().await?;

    track::Entity::find_by_id(track_id.clone())
        .one(&transaction)
        .await?
        .ok_or_else(|| AppError::InvalidRequest("track does not exist".to_owned()))?;

    let now = Utc::now();
    for related_place in place::Entity::find()
        .filter(place::Column::RelatedTrackId.eq(track_id.clone()))
        .all(&transaction)
        .await?
    {
        let mut model: place::ActiveModel = related_place.into();
        model.related_track_id = Set(None);
        model.updated_at = Set(now);
        model.update(&transaction).await?;
    }

    delete_object_links(&transaction, "track", &track_id).await?;
    track::Entity::delete_by_id(track_id)
        .exec(&transaction)
        .await?;
    transaction.commit().await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn delete_object_links<C>(connection: &C, object_type: &str, object_id: &str) -> AppResult<()>
where
    C: sea_orm::ConnectionTrait,
{
    membership::Entity::delete_many()
        .filter(membership::Column::ObjectType.eq(object_type))
        .filter(membership::Column::ObjectId.eq(object_id))
        .exec(connection)
        .await?;
    object_tag::Entity::delete_many()
        .filter(object_tag::Column::ObjectType.eq(object_type))
        .filter(object_tag::Column::ObjectId.eq(object_id))
        .exec(connection)
        .await?;

    Ok(())
}

fn search_place_condition(search: &str) -> Condition {
    Condition::any()
        .add(place::Column::Name.contains(search))
        .add(place::Column::Category.contains(search))
        .add(place::Column::Notes.contains(search))
        .add(
            place::Column::Id.in_subquery(
                object_tag::Entity::find()
                    .select_only()
                    .column(object_tag::Column::ObjectId)
                    .filter(object_tag::Column::ObjectType.eq("place"))
                    .filter(
                        object_tag::Column::TagId.in_subquery(
                            tag::Entity::find()
                                .select_only()
                                .column(tag::Column::Id)
                                .filter(tag::Column::Name.contains(search))
                                .into_query(),
                        ),
                    )
                    .into_query(),
            ),
        )
        .add(
            place::Column::Id.in_subquery(
                membership::Entity::find()
                    .select_only()
                    .column(membership::Column::ObjectId)
                    .filter(membership::Column::ObjectType.eq("place"))
                    .filter(
                        membership::Column::CollectionId.in_subquery(
                            collection::Entity::find()
                                .select_only()
                                .column(collection::Column::Id)
                                .filter(collection::Column::Name.contains(search))
                                .into_query(),
                        ),
                    )
                    .into_query(),
            ),
        )
}

fn search_track_condition(search: &str) -> Condition {
    Condition::any()
        .add(track::Column::Title.contains(search))
        .add(track::Column::OriginalFilename.contains(search))
        .add(track::Column::Notes.contains(search))
        .add(
            track::Column::Id.in_subquery(
                object_tag::Entity::find()
                    .select_only()
                    .column(object_tag::Column::ObjectId)
                    .filter(object_tag::Column::ObjectType.eq("track"))
                    .filter(
                        object_tag::Column::TagId.in_subquery(
                            tag::Entity::find()
                                .select_only()
                                .column(tag::Column::Id)
                                .filter(tag::Column::Name.contains(search))
                                .into_query(),
                        ),
                    )
                    .into_query(),
            ),
        )
        .add(
            track::Column::Id.in_subquery(
                membership::Entity::find()
                    .select_only()
                    .column(membership::Column::ObjectId)
                    .filter(membership::Column::ObjectType.eq("track"))
                    .filter(
                        membership::Column::CollectionId.in_subquery(
                            collection::Entity::find()
                                .select_only()
                                .column(collection::Column::Id)
                                .filter(collection::Column::Name.contains(search))
                                .into_query(),
                        ),
                    )
                    .into_query(),
            ),
        )
}

fn place_condition(query: &MapObjectsQuery) -> AppResult<Condition> {
    if let Some(object_type) = query.object_type.as_deref()
        && object_type != "place"
        && object_type != "track"
    {
        return Err(AppError::InvalidRequest(format!(
            "unsupported object_type `{object_type}`"
        )));
    }

    let mut condition = Condition::all()
        .add(place::Column::Latitude.gte(query.min_lat))
        .add(place::Column::Latitude.lte(query.max_lat))
        .add(place_longitude_condition(query));

    if let Some(collection_id) = &query.collection_id {
        condition = condition.add(
            place::Column::Id.in_subquery(
                membership::Entity::find()
                    .select_only()
                    .column(membership::Column::ObjectId)
                    .filter(membership::Column::ObjectType.eq("place"))
                    .filter(membership::Column::CollectionId.eq(collection_id.clone()))
                    .into_query(),
            ),
        );
    }

    if let Some(tag_name) = &query.tag {
        condition = condition.add(
            place::Column::Id.in_subquery(
                object_tag::Entity::find()
                    .select_only()
                    .column(object_tag::Column::ObjectId)
                    .filter(object_tag::Column::ObjectType.eq("place"))
                    .filter(
                        object_tag::Column::TagId.in_subquery(
                            tag::Entity::find()
                                .select_only()
                                .column(tag::Column::Id)
                                .filter(tag::Column::Name.eq(tag_name.clone()))
                                .into_query(),
                        ),
                    )
                    .into_query(),
            ),
        );
    }

    if let Some(starts_after) = query.starts_after {
        condition = condition.add(place::Column::VisitEnd.gte(starts_after));
    }

    if let Some(ends_before) = query.ends_before {
        condition = condition.add(place::Column::VisitStart.lte(ends_before));
    }

    Ok(condition)
}

fn place_longitude_condition(query: &MapObjectsQuery) -> Condition {
    if query.min_lon <= query.max_lon {
        return Condition::all()
            .add(place::Column::Longitude.gte(query.min_lon))
            .add(place::Column::Longitude.lte(query.max_lon));
    }

    Condition::any()
        .add(place::Column::Longitude.gte(query.min_lon))
        .add(place::Column::Longitude.lte(query.max_lon))
}

fn track_condition(query: &MapObjectsQuery) -> AppResult<Condition> {
    let mut condition = Condition::all()
        .add(track::Column::MinLat.lte(query.max_lat))
        .add(track::Column::MaxLat.gte(query.min_lat))
        .add(track_longitude_condition(query));

    if let Some(collection_id) = &query.collection_id {
        condition = condition.add(
            track::Column::Id.in_subquery(
                membership::Entity::find()
                    .select_only()
                    .column(membership::Column::ObjectId)
                    .filter(membership::Column::ObjectType.eq("track"))
                    .filter(membership::Column::CollectionId.eq(collection_id.clone()))
                    .into_query(),
            ),
        );
    }

    if let Some(tag_name) = &query.tag {
        condition = condition.add(
            track::Column::Id.in_subquery(
                object_tag::Entity::find()
                    .select_only()
                    .column(object_tag::Column::ObjectId)
                    .filter(object_tag::Column::ObjectType.eq("track"))
                    .filter(
                        object_tag::Column::TagId.in_subquery(
                            tag::Entity::find()
                                .select_only()
                                .column(tag::Column::Id)
                                .filter(tag::Column::Name.eq(tag_name.clone()))
                                .into_query(),
                        ),
                    )
                    .into_query(),
            ),
        );
    }

    if let Some(starts_after) = query.starts_after {
        condition = condition.add(track::Column::EndTime.gte(starts_after));
    }

    if let Some(ends_before) = query.ends_before {
        condition = condition.add(track::Column::StartTime.lte(ends_before));
    }

    Ok(condition)
}

fn track_longitude_condition(query: &MapObjectsQuery) -> Condition {
    if query.min_lon <= query.max_lon {
        return Condition::all()
            .add(track::Column::MinLon.lte(query.max_lon))
            .add(track::Column::MaxLon.gte(query.min_lon));
    }

    Condition::any()
        .add(track::Column::MaxLon.gte(query.min_lon))
        .add(track::Column::MinLon.lte(query.max_lon))
}

fn validate_collection_kind(kind: &str) -> AppResult<()> {
    match kind {
        "trip" | "future" | "past" | "general" => Ok(()),
        _ => Err(AppError::InvalidRequest(format!(
            "unsupported collection kind `{kind}`"
        ))),
    }
}

struct TrackImportSummary {
    geometry_json: String,
    min_lat: f64,
    min_lon: f64,
    max_lat: f64,
    max_lon: f64,
    distance_m: f64,
    start_time: Option<DateTime<Utc>>,
    end_time: Option<DateTime<Utc>>,
}

fn summarize_gpx_track(parsed_track: &gpx::Track) -> AppResult<TrackImportSummary> {
    let mut segments = Vec::new();
    let mut min_lat = f64::MAX;
    let mut min_lon = f64::MAX;
    let mut max_lat = f64::MIN;
    let mut max_lon = f64::MIN;
    let mut distance_m = 0.0;
    let mut start_time: Option<DateTime<Utc>> = None;
    let mut end_time: Option<DateTime<Utc>> = None;

    for segment in &parsed_track.segments {
        let mut segment_coords = Vec::new();
        let mut previous = None;

        for waypoint in &segment.points {
            let point = waypoint.point();
            let lon = point.x();
            let lat = point.y();
            let mut coordinate = vec![lon, lat];
            if let Some(elevation) = waypoint.elevation {
                coordinate.push(elevation);
            }
            segment_coords.push(coordinate);
            min_lat = min_lat.min(lat);
            min_lon = min_lon.min(lon);
            max_lat = max_lat.max(lat);
            max_lon = max_lon.max(lon);

            if let Some((prev_lat, prev_lon)) = previous {
                distance_m += haversine_distance_m(prev_lat, prev_lon, lat, lon);
            }
            previous = Some((lat, lon));

            if let Some(waypoint_time) = waypoint.time {
                let timestamp = gpx_time_to_utc(waypoint_time)?;
                start_time = Some(match start_time {
                    Some(current) => current.min(timestamp),
                    None => timestamp,
                });
                end_time = Some(match end_time {
                    Some(current) => current.max(timestamp),
                    None => timestamp,
                });
            }
        }

        if !segment_coords.is_empty() {
            segments.push(segment_coords);
        }
    }

    if segments.is_empty() {
        return Err(AppError::InvalidRequest(
            "GPX file did not contain any usable track points".to_owned(),
        ));
    }

    let geometry = if segments.len() == 1 {
        Geometry::new_line_string(
            segments
                .into_iter()
                .next()
                .ok_or_else(|| AppError::Internal("missing segment".to_string()))?,
        )
    } else {
        Geometry::new_multi_line_string(segments)
    };

    Ok(TrackImportSummary {
        geometry_json: serde_json::to_string(&geometry)
            .map_err(|error| AppError::Internal(format!("could not encode GeoJSON: {error}")))?,
        min_lat,
        min_lon,
        max_lat,
        max_lon,
        distance_m,
        start_time,
        end_time,
    })
}

fn gpx_time_to_utc(value: gpx::Time) -> AppResult<DateTime<Utc>> {
    let rendered = value.format().map_err(|error| {
        AppError::InvalidRequest(format!("GPX timestamp could not be read: {error}"))
    })?;
    let parsed = DateTime::parse_from_rfc3339(&rendered)
        .map_err(|error| AppError::InvalidRequest(format!("GPX timestamp was invalid: {error}")))?;
    Ok(parsed.with_timezone(&Utc))
}

fn haversine_distance_m(from_lat: f64, from_lon: f64, to_lat: f64, to_lon: f64) -> f64 {
    let earth_radius_m = 6_371_000.0;
    let lat1 = from_lat.to_radians();
    let lat2 = to_lat.to_radians();
    let delta_lat = (to_lat - from_lat).to_radians();
    let delta_lon = (to_lon - from_lon).to_radians();

    let a =
        (delta_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (delta_lon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());

    earth_radius_m * c
}

fn trim_optional_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn uploaded_filename_basename(value: &str) -> Option<&str> {
    value
        .rsplit(['/', '\\'])
        .find(|segment| !segment.trim().is_empty())
}
