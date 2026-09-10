// ClickHouse bindings exposed to the Wails frontend. Methods are thin: they
// delegate to the service layer; dangerous operations (truncate / SQL console)
// are audited.
package backend

import (
	"strings"

	"dataBasePro/backend/internal/model"
)

// DriverInfo describes one builtin driver for the driver management page.
// The drivers ship as native Go libraries; there is no external path.
type DriverInfo struct {
	Name        string `json:"name"`
	Library     string `json:"library"`
	Version     string `json:"version"`
	DefaultPort int    `json:"default_port"`
	Description string `json:"description"`
}

// builtinDrivers is the static registry shown by ListDrivers.
var builtinDrivers = []DriverInfo{
	{
		Name:        "Kafka",
		Library:     "franz-go",
		Version:     "v1.21.6",
		DefaultPort: 9092,
		Description: "Kafka 集群管理与消息收发(原生 TCP 协议)",
	},
	{
		Name:        "Redis",
		Library:     "go-redis",
		Version:     "v9.22.0",
		DefaultPort: 6379,
		Description: "Redis 单机/集群键空间浏览与编辑",
	},
	{
		Name:        "ClickHouse",
		Library:     "clickhouse-go",
		Version:     "v2.48.0",
		DefaultPort: 9000,
		Description: "ClickHouse 库表浏览、分页查询与 SQL 控制台(原生 TCP 协议)",
	},
	{
		Name:        "MySQL",
		Library:     "go-sql-driver/mysql",
		Version:     "v1.10.1",
		DefaultPort: 3306,
		Description: "MySQL 库表浏览、分页查询与 SQL 控制台(原生 TCP 协议)",
	},
	{
		Name:        "TiDB",
		Library:     "go-sql-driver/mysql",
		Version:     "v1.10.1",
		DefaultPort: 4000,
		Description: "TiDB 库表浏览、分页查询与 SQL 控制台(兼容 MySQL 协议)",
	},
}

// CHTablesRequest carries the table-listing parameters.
type CHTablesRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	// ShowSystem keeps the builtin system catalogs visible when true.
	ShowSystem bool `json:"show_system"`
}

// CHPageRowsRequest carries one page request over a table.
type CHPageRowsRequest struct {
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

// CHTruncateTableRequest addresses the table to empty.
type CHTruncateTableRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	Table        string `json:"table"`
	// OnCluster appends ON CLUSTER (Distributed engines); the cluster name is
	// resolved server-side as the one with the most nodes.
	OnCluster bool `json:"on_cluster,omitempty"`
}

// CHExecuteRequest carries the multi-statement SQL script.
type CHExecuteRequest struct {
	ConnectionID string `json:"connection_id"`
	SQL          string `json:"sql"`
}

// TestCHConnection verifies reachability without persisting anything.
func (a *App) TestCHConnection(cfg model.ClickHouseConfig) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.CHTestConnection(ctx, cfg)
}

// ListCHDatabases lists the user databases (system catalogs filtered
// server-side).
func (a *App) ListCHDatabases(connectionID string) ([]string, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.CHDatabases(ctx, connectionID)
}

// ListCHTables lists a database's tables with engine and row counts.
func (a *App) ListCHTables(req CHTablesRequest) ([]model.CHTableInfo, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.CHTables(ctx, req.ConnectionID, req.Database, req.ShowSystem)
}

// CHPageRows returns one page of a table's rows with metadata.
func (a *App) CHPageRows(req CHPageRowsRequest) (model.CHPageRowsResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.CHPageRows(ctx, req.ConnectionID, req.Database, req.Table, req.Where, req.OrderBy, req.Asc, req.Limit, req.Offset)
}

// CHTruncateTable empties a table (dangerous, audited).
func (a *App) CHTruncateTable(req CHTruncateTableRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.CHTruncateTable(ctx, req.ConnectionID, req.Database, req.Table, req.OnCluster)
	a.audit(req.ConnectionID, "ch_truncate_table", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}

// CHExecute runs a SQL script statement by statement (dangerous, audited; the
// audit target is the script's first 60 characters).
func (a *App) CHExecute(req CHExecuteRequest) ([]model.CHStatementResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	results, err := a.svc.CHExecute(ctx, req.ConnectionID, req.SQL)
	a.audit(req.ConnectionID, "ch_execute", auditSQLTarget(req.SQL), auditResult(err), auditDetail(err))
	return results, err
}

// CHPreviewCellUpdate previews a cell update: it renders the exact
// ALTER TABLE ... UPDATE statement and counts the rows matched by the same
// WHERE conditions, executing nothing (read-only, not audited).
func (a *App) CHPreviewCellUpdate(req model.CHCellUpdateRequest) (model.CHCellUpdatePreview, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.CHPreviewCellUpdate(ctx, req.ConnectionID, req.Database, req.Table, req.Set, req.Where)
}

// CHUpdateCell executes a cell update as a synchronous mutation (dangerous,
// audited like truncate: action ch_update_cell, target db.table; the audit
// carries no credentials and no statement text, matching truncate's style).
func (a *App) CHUpdateCell(req model.CHCellUpdateRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.CHUpdateCell(ctx, req.ConnectionID, req.Database, req.Table, req.Set, req.Where)
	a.audit(req.ConnectionID, "ch_update_cell", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}

// ListDrivers returns the static registry of builtin drivers.
func (a *App) ListDrivers() ([]DriverInfo, error) {
	out := make([]DriverInfo, len(builtinDrivers))
	copy(out, builtinDrivers)
	return out, nil
}

// auditSQLTarget renders the audit target for a SQL script: the trimmed first
// 60 characters (rune-safe).
func auditSQLTarget(sql string) string {
	sql = strings.TrimSpace(sql)
	runes := []rune(sql)
	if len(runes) > 60 {
		return string(runes[:60])
	}
	return sql
}
