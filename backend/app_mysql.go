// MySQL/TiDB bindings exposed to the Wails frontend. TiDB speaks the MySQL
// protocol, so one implementation serves both connection types. Methods are
// thin: they delegate to the service layer; dangerous operations (truncate /
// SQL console / cell update) are audited.
package backend

import (
	"dataBasePro/backend/internal/model"
)

// MysqlTablesRequest carries the table-listing parameters.
type MysqlTablesRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
}

// MysqlPageRowsRequest carries one page request over a table.
type MysqlPageRowsRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	Table        string `json:"table"`
	// Where is the user's native WHERE fragment (without the keyword); empty
	// omits the clause.
	Where   string `json:"where,omitempty"`
	OrderBy string `json:"order_by,omitempty"`
	Asc     bool   `json:"asc"`
	Limit   int    `json:"limit"`
	Offset  int    `json:"offset"`
}

// MysqlTruncateTableRequest addresses the table to empty.
type MysqlTruncateTableRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	Table        string `json:"table"`
}

// MysqlExecuteRequest carries the multi-statement SQL script. Database is the
// console's current database context: non-empty runs the whole script on one
// connection pinned to it via USE; empty keeps the pool default (no USE).
type MysqlExecuteRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database,omitempty"`
	SQL          string `json:"sql"`
}

// TestMysqlConnection verifies reachability without persisting anything.
func (a *App) TestMysqlConnection(cfg model.MysqlConfig) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.MysqlTestConnection(ctx, cfg)
}

// ListMysqlDatabases lists the user databases (the four built-in system
// schemas are filtered server-side).
func (a *App) ListMysqlDatabases(connectionID string) ([]string, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.MysqlDatabases(ctx, connectionID)
}

// ListMysqlTables lists a database's base tables with engine, row counts and
// comments (views are excluded).
func (a *App) ListMysqlTables(req MysqlTablesRequest) ([]model.MysqlTableInfo, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.MysqlTables(ctx, req.ConnectionID, req.Database)
}

// MysqlPageRows returns one page of a table's rows with metadata.
func (a *App) MysqlPageRows(req MysqlPageRowsRequest) (model.MysqlPageRowsResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.MysqlPageRows(ctx, req.ConnectionID, req.Database, req.Table, req.Where, req.OrderBy, req.Asc, req.Limit, req.Offset)
}

// MysqlTruncateTable empties a table (dangerous, audited).
func (a *App) MysqlTruncateTable(req MysqlTruncateTableRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.MysqlTruncateTable(ctx, req.ConnectionID, req.Database, req.Table)
	a.audit(req.ConnectionID, "mysql_truncate_table", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}

// MysqlExecute runs a SQL script statement by statement (dangerous, audited;
// the audit target is the script's first 60 characters). The console's current
// database is passed through so statements execute with that context.
func (a *App) MysqlExecute(req MysqlExecuteRequest) ([]model.MysqlStatementResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	results, err := a.svc.MysqlExecute(ctx, req.ConnectionID, req.Database, req.SQL)
	a.audit(req.ConnectionID, "mysql_execute", auditSQLTarget(req.SQL), auditResult(err), auditDetail(err))
	return results, err
}

// MysqlPreviewCellUpdate previews a cell update: it renders the display text
// of the UPDATE and counts the rows matched by the same WHERE conditions,
// executing nothing (read-only, not audited).
func (a *App) MysqlPreviewCellUpdate(req model.MysqlCellUpdateRequest) (model.MysqlCellUpdatePreview, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.MysqlPreviewCellUpdate(ctx, req.ConnectionID, req.Database, req.Table, req.Set, req.Where)
}

// MysqlUpdateCell executes a parameterized cell update (dangerous, audited
// like truncate: action mysql_update_cell, target db.table; the audit carries
// no credentials and no statement text, matching truncate's style).
func (a *App) MysqlUpdateCell(req model.MysqlCellUpdateRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.MysqlUpdateCell(ctx, req.ConnectionID, req.Database, req.Table, req.Set, req.Where)
	a.audit(req.ConnectionID, "mysql_update_cell", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}
