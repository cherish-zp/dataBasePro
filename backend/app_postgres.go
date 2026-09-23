package backend

import (
	"dataBasePro/backend/internal/model"
)

// PostgresTablesRequest addresses one schema.
type PostgresTablesRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	Schema       string `json:"schema"`
}

// PostgresSchemasRequest addresses one database.
type PostgresSchemasRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
}

// PostgresPageRowsRequest carries one page request over a relation.
type PostgresPageRowsRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	Schema       string `json:"schema"`
	Relation     string `json:"relation"`
	RelationKind string `json:"relation_kind,omitempty"`
	Where        string `json:"where,omitempty"`
	OrderBy      string `json:"order_by,omitempty"`
	Asc          bool   `json:"asc"`
	Limit        int    `json:"limit"`
	Offset       int    `json:"offset"`
}

// PostgresTruncateTableRequest addresses the table to empty.
type PostgresTruncateTableRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	Schema       string `json:"schema"`
	Relation     string `json:"relation"`
	RelationKind string `json:"relation_kind"`
}

// PostgresExecuteRequest carries a multi-statement SQL script and its schema.
type PostgresExecuteRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database,omitempty"`
	Schema       string `json:"schema,omitempty"`
	SQL          string `json:"sql"`
}

// TestPostgresConnection verifies reachability without persisting anything.
func (a *App) TestPostgresConnection(cfg model.PostgresConfig) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.PostgresTestConnection(ctx, cfg)
}

// ListPostgresDatabases lists connectable non-template databases.
func (a *App) ListPostgresDatabases(connectionID string) ([]string, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.PostgresDatabases(ctx, connectionID)
}

// ListPostgresSchemas lists user schemas in one database.
func (a *App) ListPostgresSchemas(req PostgresSchemasRequest) ([]string, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.PostgresSchemas(ctx, req.ConnectionID, req.Database)
}

// ListPostgresTables lists relations in one schema.
func (a *App) ListPostgresTables(req PostgresTablesRequest) ([]model.PostgresTableInfo, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.PostgresTables(ctx, req.ConnectionID, req.Database, req.Schema)
}

// PostgresPageRows returns one page of rows and metadata.
func (a *App) PostgresPageRows(req PostgresPageRowsRequest) (model.PostgresPageRowsResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.PostgresPageRows(ctx, req.ConnectionID, req.Database, req.Schema, req.Relation,
		req.RelationKind, req.Where, req.OrderBy, req.Asc, req.Limit, req.Offset)
}

// PostgresExecute runs a SQL script (dangerous, audited).
func (a *App) PostgresExecute(req PostgresExecuteRequest) ([]model.PostgresStatementResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	results, err := a.svc.PostgresExecute(ctx, req.ConnectionID, req.Database, req.Schema, req.SQL)
	a.audit(req.ConnectionID, "postgres_execute", auditSQLTarget(req.SQL), auditResult(err), auditDetail(err))
	return results, err
}

// PostgresTruncateTable empties an ordinary table (dangerous, audited).
func (a *App) PostgresTruncateTable(req PostgresTruncateTableRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.PostgresTruncateTable(ctx, req.ConnectionID, req.Database, req.Schema, req.Relation, req.RelationKind)
	a.audit(req.ConnectionID, "postgres_truncate_table", req.Database+"."+req.Schema+"."+req.Relation, auditResult(err), auditDetail(err))
	return err
}

// PostgresPreviewCellUpdate previews a parameterized primary-key update.
func (a *App) PostgresPreviewCellUpdate(req model.PostgresCellUpdateRequest) (model.PostgresCellUpdatePreview, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.PostgresPreviewCellUpdate(ctx, req)
}

// PostgresUpdateCell executes a parameterized primary-key update (dangerous, audited).
func (a *App) PostgresUpdateCell(req model.PostgresCellUpdateRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.PostgresUpdateCell(ctx, req)
	a.audit(req.ConnectionID, "postgres_update_cell", req.Database+"."+req.Schema+"."+req.Relation, auditResult(err), auditDetail(err))
	return err
}
