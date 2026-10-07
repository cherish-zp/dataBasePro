// MySQL/TiDB 表级 DDL/导出绑定:连接树右键的删除表、编辑表字段与导出。
// 方法保持薄:委托 service 层;危险操作(DROP/ALTER/导出)与截断同风格落
// 审计(action mysql_drop_table / mysql_alter_table / mysql_export_table,
// target 为 db.table,不含凭据与语句文本)。TableColumns 只读,不审计。
package backend

import (
	"context"
	"time"

	"sheng-shou-yun-he/backend/internal/service"
)

// exportTimeout 单独放宽导出的调用上限:大表导出远超常规 methodTimeout(60s),
// 60 秒被掐断的报错既难懂又诱导用户在等待中误触其它操作。
const exportTimeout = 10 * time.Minute

// MysqlDropTableRequest addresses the table to drop.
type MysqlDropTableRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	Table        string `json:"table"`
}

// MysqlTableColumnsRequest addresses the table whose structure is read.
type MysqlTableColumnsRequest struct {
	ConnectionID string `json:"connection_id"`
	Database     string `json:"database"`
	Table        string `json:"table"`
}

// MysqlAlterTableRequest carries the three structure-change groups; they run
// in ADD → MODIFY → DROP order inside the service layer.
type MysqlAlterTableRequest struct {
	ConnectionID  string                   `json:"connection_id"`
	Database      string                   `json:"database"`
	Table         string                   `json:"table"`
	AddColumns    []service.MysqlColumnDef `json:"add_columns"`
	ModifyColumns []service.MysqlColumnDef `json:"modify_columns"`
	DropColumns   []string                 `json:"drop_columns"`
}

// MysqlExportTableRequest describes one export: include_ddl 与 include_data
// 至少选一;data_limit (0/absent) caps the exported row count;insert_per_row
// 每行一条独立 INSERT,drop_table_if_exists 在结构段前置 DROP 行,
// strip_auto_increment 剥离表级 AUTO_INCREMENT 计数,include_create_db 加
// 建库头部。
type MysqlExportTableRequest struct {
	ConnectionID       string `json:"connection_id"`
	Database           string `json:"database"`
	Table              string `json:"table"`
	IncludeData        bool   `json:"include_data"`
	DataLimit          int    `json:"data_limit,omitempty"`
	IncludeDDL         bool   `json:"include_ddl"`
	InsertPerRow       bool   `json:"insert_per_row"`
	DropTableIfExists  bool   `json:"drop_table_if_exists"`
	StripAutoIncrement bool   `json:"strip_auto_increment"`
	IncludeCreateDB    bool   `json:"include_create_db"`
}

// MysqlDropTable drops the table (dangerous, audited).
func (a *App) MysqlDropTable(req MysqlDropTableRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.MysqlDropTable(ctx, req.ConnectionID, req.Database, req.Table)
	a.audit(req.ConnectionID, "mysql_drop_table", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}

// MysqlTableColumns returns the table's full column metadata plus its DDL
// (read-only, not audited).
func (a *App) MysqlTableColumns(req MysqlTableColumnsRequest) (service.MysqlTableColumnsResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.MysqlTableColumns(ctx, req.ConnectionID, req.Database, req.Table)
}

// MysqlAlterTable applies the structure changes (dangerous, audited).
func (a *App) MysqlAlterTable(req MysqlAlterTableRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.MysqlAlterTable(ctx, req.ConnectionID, service.MysqlAlterTableSpec{
		Database:      req.Database,
		Table:         req.Table,
		AddColumns:    req.AddColumns,
		ModifyColumns: req.ModifyColumns,
		DropColumns:   req.DropColumns,
	})
	a.audit(req.ConnectionID, "mysql_alter_table", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}

// MysqlExportTable renders the table's .sql script (audited like truncate).
// 走独立的放宽超时:导出不受 60s methodTimeout 约束。
func (a *App) MysqlExportTable(req MysqlExportTableRequest) (service.MysqlExportTableResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), exportTimeout)
	defer cancel()
	res, err := a.svc.MysqlExportTable(ctx, req.ConnectionID, service.MysqlExportSpec{
		Database:           req.Database,
		Table:              req.Table,
		IncludeData:        req.IncludeData,
		DataLimit:          req.DataLimit,
		IncludeDDL:         req.IncludeDDL,
		InsertPerRow:       req.InsertPerRow,
		DropTableIfExists:  req.DropTableIfExists,
		StripAutoIncrement: req.StripAutoIncrement,
		IncludeCreateDB:    req.IncludeCreateDB,
	})
	a.audit(req.ConnectionID, "mysql_export_table", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return res, err
}
