use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            ColumnDef::new(MapJobs::CurrentStep)
                .string()
                .not_null()
                .default("queued")
                .to_owned(),
            ColumnDef::new(MapJobs::ProgressPercent)
                .integer()
                .not_null()
                .default(0)
                .to_owned(),
            ColumnDef::new(MapJobs::SegmentsDone)
                .integer()
                .not_null()
                .default(0)
                .to_owned(),
            ColumnDef::new(MapJobs::SegmentsTotal)
                .integer()
                .not_null()
                .default(0)
                .to_owned(),
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(MapJobs::Table)
                        .add_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            MapJobs::SegmentsTotal,
            MapJobs::SegmentsDone,
            MapJobs::ProgressPercent,
            MapJobs::CurrentStep,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(MapJobs::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum MapJobs {
    Table,
    CurrentStep,
    ProgressPercent,
    SegmentsDone,
    SegmentsTotal,
}
