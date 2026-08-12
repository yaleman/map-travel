use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Tracks::Table)
                    .add_column(ColumnDef::new(Tracks::GpxMetadataJson).text())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Tracks::Table)
                    .drop_column(Tracks::GpxMetadataJson)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Tracks {
    Table,
    GpxMetadataJson,
}
