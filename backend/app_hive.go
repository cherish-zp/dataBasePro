// Hive(HiveServer2)绑定:连接树与 SQL 控制台的 Hive 全套操作。方法保持薄:
// 委托 service 层;危险操作(截断/删表/单元格更新/按行删除/编辑表字段/导出)
// 与既有数据源同风格落审计(action hive_truncate_table / hive_drop_table /
// hive_update_cell / hive_delete_row / hive_alter_table / hive_export_table,
// target 为 db.table,不含凭据与语句文本)。预览类与只读方法不审计。
package backend

import (
	"context"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/service"
)

// HiveTablesRequest addresses one database.
type HiveTablesRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
}

// HivePageRowsRequest carries one page request over a table.
type HivePageRowsRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	Table        string `json:"table"`
	Limit        int    `json:"limit"`
	Offset       int    `json:"offset"`
}

// HiveExecuteRequest carries a multi-statement SQL script. Database 非空时
// 后端在该库上执行(等效 USE);Limit>0 启用服务端分页(可包装 SELECT 用
// ROW_NUMBER 窗口;SHOW/DESCRIBE 类截断回退),缺省全量返回。
type HiveExecuteRequest struct {
	ConnectionID string `json:"connection_id"`
	SQL          string `json:"sql"`
	Database     string `json:"database,omitempty"`
	Limit        int    `json:"limit,omitempty"`
	Offset       int    `json:"offset,omitempty"`
}

// HiveTableRequest addresses the table for DDL operations.
type HiveTableRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	Table        string `json:"table"`
}

// HiveAlterTableRequest carries the three structure-change groups; they run
// in ADD → CHANGE → DROP order inside the service layer(DROP COLUMN 失败
// 自动降级 REPLACE COLUMNS 重建)。
type HiveAlterTableRequest struct {
	ConnectionID  string                  `json:"connection_id"`
	Database      string                  `json:"database"`
	Table         string                  `json:"table"`
	AddColumns    []service.HiveColumnDef `json:"add_columns"`
	ModifyColumns []service.HiveColumnDef `json:"modify_columns"`
	DropColumns   []string                `json:"drop_columns"`
}

// TestHiveConnection verifies reachability without persisting anything.
func (a *App) TestHiveConnection(cfg model.HiveConfig) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.HiveTestConnection(ctx, cfg)
}

// ListHiveDatabases lists the databases of the connection's HiveServer2.
func (a *App) ListHiveDatabases(connectionID string) ([]string, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.HiveDatabases(ctx, connectionID)
}

// ListHiveTables lists a database's tables.
func (a *App) ListHiveTables(req HiveTablesRequest) ([]model.HiveTableInfo, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.HiveTables(ctx, req.ConnectionID, req.Database)
}

// HiveTableColumns returns a table's metadata bundle (read-only, not audited).
func (a *App) HiveTableColumns(req HiveTableRequest) (model.HiveTableColumnsResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.HiveTableColumns(ctx, req.ConnectionID, req.Database, req.Table)
}

// HivePageRows returns one page of rows and metadata.
func (a *App) HivePageRows(req HivePageRowsRequest) (model.HivePageRowsResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.HivePageRows(ctx, req.ConnectionID, req.Database, req.Table, req.Limit, req.Offset)
}

// HiveExecute runs a SQL script (dangerous, audited).
func (a *App) HiveExecute(req HiveExecuteRequest) ([]model.HiveStatementResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	results, err := a.svc.HiveExecute(ctx, req.ConnectionID, req.Database, req.SQL, req.Limit, req.Offset)
	a.audit(req.ConnectionID, "hive_execute", auditSQLTarget(req.SQL), auditResult(err), auditDetail(err))
	return results, err
}

// HivePreviewCellUpdate previews an ACID cell update (read-only).
func (a *App) HivePreviewCellUpdate(req model.HiveCellUpdateRequest) (model.HiveCellUpdatePreview, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.HivePreviewCellUpdate(ctx, req.ConnectionID, req.Database, req.Table, req.Set, req.Where)
}

// HiveUpdateCell executes an ACID cell update (dangerous, audited).
func (a *App) HiveUpdateCell(req model.HiveCellUpdateRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.HiveUpdateCell(ctx, req.ConnectionID, req.Database, req.Table, req.Set, req.Where)
	a.audit(req.ConnectionID, "hive_update_cell", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}

// HivePreviewDeleteRow previews an ACID row delete (read-only).
func (a *App) HivePreviewDeleteRow(req model.HiveDeleteRowRequest) (model.HiveDeleteRowPreview, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.HivePreviewDeleteRow(ctx, req.ConnectionID, req.Database, req.Table, req.Where)
}

// HiveDeleteRow executes an ACID row delete (dangerous, audited).
func (a *App) HiveDeleteRow(req model.HiveDeleteRowRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.HiveDeleteRow(ctx, req.ConnectionID, req.Database, req.Table, req.Where)
	a.audit(req.ConnectionID, "hive_delete_row", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}

// HiveTruncateTable empties an internal table (dangerous, audited).
func (a *App) HiveTruncateTable(req HiveTableRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.HiveTruncateTable(ctx, req.ConnectionID, req.Database, req.Table)
	a.audit(req.ConnectionID, "hive_truncate_table", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}

// HiveDropTable drops the table (dangerous, audited).
func (a *App) HiveDropTable(req HiveTableRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.HiveDropTable(ctx, req.ConnectionID, req.Database, req.Table)
	a.audit(req.ConnectionID, "hive_drop_table", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}

// HiveAlterTable applies the structure changes (dangerous, audited).
func (a *App) HiveAlterTable(req HiveAlterTableRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.HiveAlterTable(ctx, req.ConnectionID, service.HiveAlterTableSpec{
		Database:      req.Database,
		Table:         req.Table,
		AddColumns:    req.AddColumns,
		ModifyColumns: req.ModifyColumns,
		DropColumns:   req.DropColumns,
	})
	a.audit(req.ConnectionID, "hive_alter_table", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}

// HiveExportTable renders the table's .sql DDL script (audited like truncate).
// 走独立的放宽超时:导出不受 60s methodTimeout 约束。
func (a *App) HiveExportTable(req HiveTableRequest) (service.HiveExportTableResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), exportTimeout)
	defer cancel()
	res, err := a.svc.HiveExportTable(ctx, req.ConnectionID, req.Database, req.Table)
	a.audit(req.ConnectionID, "hive_export_table", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return res, err
}
