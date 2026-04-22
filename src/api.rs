use std::sync::Arc;
use std::{io::BufReader, io::Cursor};

use axum::{
    Json, Router,
    extract::{Multipart, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use geojson::Geometry;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition, EntityTrait, QueryFilter,
    QuerySelect, QueryTrait,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    app::AppContext,
    entities::{collection, membership, object_tag, place, tag, track},
    error::{AppError, AppResult},
};

pub fn build_router(context: Arc<AppContext>) -> Router {
    Router::new()
        .route("/api/collections", post(create_collection))
        .route("/api/collections", get(list_collections))
        .route("/api/places", post(create_place))
        .route("/api/tracks/import", post(import_tracks))
        .route("/api/map-objects", get(list_map_objects))
        .merge(crate::maps_api::build_router())
        .with_state(context)
}

#[derive(Debug, Deserialize)]
struct CreateCollectionRequest {
    name: String,
    kind: String,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
struct CollectionResponse {
    id: String,
    name: String,
    kind: String,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
    is_public: bool,
}

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

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
struct ImportTracksResponse {
    tracks: Vec<TrackResponse>,
}

async fn import_tracks(
    State(context): State<Arc<AppContext>>,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<ImportTracksResponse>)> {
    let mut file_bytes = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::InvalidRequest(format!("invalid multipart upload: {error}")))?
    {
        if field.name() == Some("file") {
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

        imported.push(TrackResponse {
            id: created.id,
            title: created.title,
            notes: created.notes,
            geometry_json: created.geometry_json,
            min_lat: created.min_lat,
            min_lon: created.min_lon,
            max_lat: created.max_lat,
            max_lon: created.max_lon,
            distance_m: created.distance_m,
            start_time: created.start_time,
            end_time: created.end_time,
        });
    }

    Ok((
        StatusCode::CREATED,
        Json(ImportTracksResponse { tracks: imported }),
    ))
}

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Serialize)]
struct MapObjectsResponse {
    tracks: Vec<TrackResponse>,
    places: Vec<PlaceResponse>,
}

#[derive(Debug, Serialize)]
struct TrackResponse {
    id: String,
    title: Option<String>,
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
            .map(|model| TrackResponse {
                id: model.id,
                title: model.title,
                notes: model.notes,
                geometry_json: model.geometry_json,
                min_lat: model.min_lat,
                min_lon: model.min_lon,
                max_lat: model.max_lat,
                max_lon: model.max_lon,
                distance_m: model.distance_m,
                start_time: model.start_time,
                end_time: model.end_time,
            })
            .collect()
    };

    Ok(Json(MapObjectsResponse { tracks, places }))
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
        .add(place::Column::Longitude.gte(query.min_lon))
        .add(place::Column::Longitude.lte(query.max_lon));

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

fn track_condition(query: &MapObjectsQuery) -> AppResult<Condition> {
    let mut condition = Condition::all()
        .add(track::Column::MinLat.lte(query.max_lat))
        .add(track::Column::MaxLat.gte(query.min_lat))
        .add(track::Column::MinLon.lte(query.max_lon))
        .add(track::Column::MaxLon.gte(query.min_lon));

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
            segment_coords.push(vec![lon, lat]);
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
