package backend

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/service"
)

// --- App 层离线 fake:实现 service.HiveConn/HiveRows,按查询文本路由
// DESCRIBE FORMATTED 与 SHOW CREATE TABLE;exec 记录语句文本。 ---

type appHiveConn struct {
	execs   []string
	queries []string
	execErr error
}

func (c *appHiveConn) Exec(_ context.Context, query string) error {
	c.execs = append(c.execs, query)
	return c.execErr
}

func (c *appHiveConn) Query(_ context.Context, query string) (service.HiveRows, error) {
	c.queries = append(c.queries, query)
	switch {
	case strings.HasPrefix(query, "DESCRIBE FORMATTED"):
		return &appHiveRows{cols: []model.HiveColumn{
			{Name: "col_name", Type: "string"}, {Name: "data_type", Type: "string"}, {Name: "comment", Type: "string"},
		}, rows: [][]*string{
			{hiveSP("# col_name"), hiveSP("data_type"), hiveSP("comment")},
			{hiveSP("id"), hiveSP("int"), hiveSP("主键")},
			{hiveSP("name"), hiveSP("string"), hiveSP("")},
			{hiveSP(""), hiveSP(""), hiveSP("")},
			{hiveSP("# Detailed Table Information"), hiveSP(""), hiveSP("")},
			{hiveSP("Table Type:"), hiveSP("MANAGED_TABLE"), hiveSP("")},
			{hiveSP("# Table Parameters:"), hiveSP("null"), hiveSP("")},
			{hiveSP("transactional"), hiveSP("true"), hiveSP("")},
		}}, nil
	case strings.HasPrefix(query, "SHOW CREATE TABLE"):
		return &appHiveRows{cols: []model.HiveColumn{{Name: "createtab_stmt", Type: "string"}},
			rows: [][]*string{{hiveSP("CREATE TABLE `t` ... CONSTRAINT `pk_t` PRIMARY KEY (`id`)")}}}, nil
	case strings.HasPrefix(query, "SHOW DATABASES"):
		return &appHiveRows{cols: []model.HiveColumn{{Name: "database_name", Type: "string"}},
			rows: [][]*string{{hiveSP("default")}, {hiveSP("dw")}}}, nil
	case strings.HasPrefix(query, "SHOW TABLES"):
		return &appHiveRows{cols: []model.HiveColumn{{Name: "tab_name", Type: "string"}},
			rows: [][]*string{{hiveSP("t")}}}, nil
	case strings.HasPrefix(query, "SELECT COUNT(*)"):
		return &appHiveRows{cols: []model.HiveColumn{{Name: "_c0", Type: "bigint"}},
			rows: [][]*string{{hiveSP("7")}}}, nil
	case strings.HasPrefix(query, "SELECT `id`"):
		return &appHiveRows{cols: []model.HiveColumn{{Name: "id", Type: "int"}, {Name: "name", Type: "string"}},
			rows: [][]*string{{hiveSP("1"), hiveSP("alice")}}}, nil
	}
	return &appHiveRows{cols: []model.HiveColumn{{Name: "x", Type: "string"}},
		rows: [][]*string{{hiveSP("v")}}}, nil
}

func (c *appHiveConn) Close() error { return nil }

// appHiveRows 是静态行集的 HiveRows 实现(NULL 用 nil 指针表达)。
type appHiveRows struct {
	cols []model.HiveColumn
	rows [][]*string
	pos  int
}

func (r *appHiveRows) Columns() []model.HiveColumn { return r.cols }

func (r *appHiveRows) Next(_ context.Context) ([]*string, bool, error) {
	if r.pos >= len(r.rows) {
		return nil, false, nil
	}
	row := r.rows[r.pos]
	r.pos++
	return row, true, nil
}

func (r *appHiveRows) Close() {}

func hiveSP(s string) *string { return &s }

func newHiveApp(t *testing.T, conn *appHiveConn) (*App, string) {
	t.Helper()
	app := newTestApp(t)
	rec, err := app.CreateConnection(&model.Connection{
		Name:   "hive-local",
		Type:   model.ConnectionTypeHive,
		Config: model.MustConfigJSON(model.HiveConfig{Host: "127.0.0.1", Port: 10000, AuthMode: "nosasl", Database: "dw"}),
	})
	if err != nil {
		t.Fatalf("create hive connection: %v", err)
	}
	client := service.NewHiveClientWithConn(conn, "dw")
	t.Cleanup(func() { _ = client.Close() })
	if err := app.svc.PutPooledForTest(rec.ID, client); err != nil {
		t.Fatalf("pool client: %v", err)
	}
	return app, rec.ID
}

// --- 只读绑定 ---

func TestAppHiveReadOnlyBindings(t *testing.T) {
	conn := &appHiveConn{}
	app, connID := newHiveApp(t, conn)

	dbs, err := app.ListHiveDatabases(connID)
	if err != nil {
		t.Fatalf("ListHiveDatabases: %v", err)
	}
	if len(dbs) != 2 || dbs[1] != "dw" {
		t.Fatalf("databases = %v", dbs)
	}
	tables, err := app.ListHiveTables(HiveTablesRequest{ConnectionID: connID, Database: "dw"})
	if err != nil {
		t.Fatalf("ListHiveTables: %v", err)
	}
	if len(tables) != 1 || tables[0].Name != "t" {
		t.Fatalf("tables = %+v", tables)
	}
	cols, err := app.HiveTableColumns(HiveTableRequest{ConnectionID: connID, Database: "dw", Table: "t"})
	if err != nil {
		t.Fatalf("HiveTableColumns: %v", err)
	}
	if !cols.Transactional || len(cols.PrimaryKey) != 1 || cols.PrimaryKey[0] != "id" {
		t.Fatalf("columns result = %+v", cols)
	}
	page, err := app.HivePageRows(HivePageRowsRequest{ConnectionID: connID, Database: "dw", Table: "t", Limit: 10, Offset: 0})
	if err != nil {
		t.Fatalf("HivePageRows: %v", err)
	}
	if page.TotalRows != 7 {
		t.Fatalf("page total = %d", page.TotalRows)
	}
	// 只读绑定不落审计(CreateConnection 自身的 create_connection 除外)。
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	for _, got := range list {
		if got.Action != "create_connection" {
			t.Fatalf("read-only bindings must not audit, got %s", auditActions(list))
		}
	}
}

// --- 预览(不审计)与写入(审计) ---

func TestAppHivePreviewAndAuditedWrites(t *testing.T) {
	conn := &appHiveConn{}
	app, connID := newHiveApp(t, conn)
	ctxIDs := model.HiveCellRef{Column: "id", Type: "int", Value: hiveSP("1")}

	preview, err := app.HivePreviewCellUpdate(model.HiveCellUpdateRequest{
		ConnectionID: connID, Database: "dw", Table: "t",
		Set:   model.HiveCellRef{Column: "name", Type: "string", Value: hiveSP("x")},
		Where: []model.HiveCellRef{ctxIDs},
	})
	if err != nil {
		t.Fatalf("HivePreviewCellUpdate: %v", err)
	}
	if preview.MatchedRows != 7 || !strings.Contains(preview.Statement, "UPDATE `dw`.`t`") {
		t.Fatalf("preview = %+v", preview)
	}
	dpreview, err := app.HivePreviewDeleteRow(model.HiveDeleteRowRequest{
		ConnectionID: connID, Database: "dw", Table: "t",
		Where: []model.HiveCellRef{ctxIDs},
	})
	if err != nil {
		t.Fatalf("HivePreviewDeleteRow: %v", err)
	}
	if !strings.Contains(dpreview.Statement, "DELETE FROM `dw`.`t`") {
		t.Fatalf("delete preview = %+v", dpreview)
	}

	if err := app.HiveUpdateCell(model.HiveCellUpdateRequest{
		ConnectionID: connID, Database: "dw", Table: "t",
		Set:   model.HiveCellRef{Column: "name", Type: "string", Value: hiveSP("x")},
		Where: []model.HiveCellRef{ctxIDs},
	}); err != nil {
		t.Fatalf("HiveUpdateCell: %v", err)
	}
	if err := app.HiveDeleteRow(model.HiveDeleteRowRequest{
		ConnectionID: connID, Database: "dw", Table: "t",
		Where: []model.HiveCellRef{ctxIDs},
	}); err != nil {
		t.Fatalf("HiveDeleteRow: %v", err)
	}
	if err := app.HiveTruncateTable(HiveTableRequest{ConnectionID: connID, Database: "dw", Table: "t"}); err != nil {
		t.Fatalf("HiveTruncateTable: %v", err)
	}
	if err := app.HiveDropTable(HiveTableRequest{ConnectionID: connID, Database: "dw", Table: "t"}); err != nil {
		t.Fatalf("HiveDropTable: %v", err)
	}
	if err := app.HiveAlterTable(HiveAlterTableRequest{
		ConnectionID: connID, Database: "dw", Table: "t",
		AddColumns: []service.HiveColumnDef{{Name: "age", Type: "int", Comment: ""}},
	}); err != nil {
		t.Fatalf("HiveAlterTable: %v", err)
	}
	if _, err := app.HiveExportTable(HiveTableRequest{ConnectionID: connID, Database: "dw", Table: "t"}); err != nil {
		t.Fatalf("HiveExportTable: %v", err)
	}

	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	// 期望动作集:导出/编辑表字段/删表/截断/删除行/更新单元格(最新在前)。
	wantActions := []string{
		"hive_export_table", "hive_alter_table", "hive_drop_table",
		"hive_truncate_table", "hive_delete_row", "hive_update_cell",
	}
	if len(list) < len(wantActions) {
		t.Fatalf("audit entries = %d, want >= %d: %+v", len(list), len(wantActions), list)
	}
	for i, action := range wantActions {
		got := list[i]
		if got.Action != action || got.Target != "dw.t" || got.Result != "ok" || got.ConnectionID != connID {
			t.Fatalf("audit[%d] = %+v, want action %s", i, got, action)
		}
	}
	// 预览类不审计。
	for _, got := range list {
		if strings.Contains(got.Action, "preview") {
			t.Fatalf("preview must not audit: %+v", got)
		}
	}
	// 危险语句确实执行。
	joined := strings.Join(conn.execs, "\n")
	for _, fragment := range []string{"UPDATE `dw`.`t`", "DELETE FROM `dw`.`t`", "TRUNCATE TABLE `dw`.`t`", "DROP TABLE `dw`.`t`", "ADD COLUMNS (`age` int)"} {
		if !strings.Contains(joined, fragment) {
			t.Fatalf("execs missing %q: %v", fragment, conn.execs)
		}
	}
}

func TestAppHiveExecuteAudited(t *testing.T) {
	conn := &appHiveConn{}
	app, connID := newHiveApp(t, conn)
	results, err := app.HiveExecute(HiveExecuteRequest{ConnectionID: connID, Database: "dw", SQL: "SELECT 1"})
	if err != nil {
		t.Fatalf("HiveExecute: %v", err)
	}
	if len(results) != 1 || results[0].SQL != "SELECT 1" {
		t.Fatalf("results = %+v", results)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	// 建连时已落一条 create_connection,执行审计是其上最新一条。
	if len(list) != 2 || list[0].Action != "hive_execute" || list[0].Result != "ok" || list[1].Action != "create_connection" {
		t.Fatalf("execute must be audited: %s", auditActions(list))
	}

	// 语句级失败:错误文本进该条结果、不上浮顶层(与 mysql 语义一致),审计仍记 ok。
	failConn := &appHiveConn{execErr: errors.New("boom")}
	failApp, failID := newHiveApp(t, failConn)
	failResults, err := failApp.HiveExecute(HiveExecuteRequest{ConnectionID: failID, SQL: "SET x=1"})
	if err != nil {
		t.Fatalf("HiveExecute with statement error must not hard-fail: %v", err)
	}
	if len(failResults) != 1 || failResults[0].Error != "boom" {
		t.Fatalf("failing statement must carry error: %+v", failResults)
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(list) != 2 || list[0].Action != "hive_execute" || list[0].Result != "ok" {
		t.Fatalf("statement-level failure must not flip audit result: %s", auditActions(list))
	}

	// 整体失败(无可执行语句)上浮为顶层错误,审计落 error + 明细。
	emptyApp, emptyID := newHiveApp(t, &appHiveConn{})
	if _, err := emptyApp.HiveExecute(HiveExecuteRequest{ConnectionID: emptyID, SQL: "  "}); err == nil {
		t.Fatal("empty script must surface as error")
	}
	list, err = emptyApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(list) != 2 || list[0].Action != "hive_execute" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed execute must be audited: %s", auditActions(list))
	}
}

// auditActions 摘要审计列表便于失败输出(指针切片直接 %+v 只打印地址)。
func auditActions(list []*model.AuditEntry) string {
	parts := make([]string, len(list))
	for i, e := range list {
		parts[i] = e.Action + "/" + e.Result
	}
	return strings.Join(parts, ",")
}

// --- JSON 契约锁定:App 请求结构与前端 types.ts 逐字段一致(snake_case)。 ---

func TestAppHiveRequestJSONShapes(t *testing.T) {
	b, err := json.Marshal(HiveExecuteRequest{ConnectionID: "c1", SQL: "SELECT 1", Database: "dw", Limit: 10, Offset: 5})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"connection_id", "sql", "database", "limit", "offset"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("HiveExecuteRequest JSON must expose %q, got %s", key, b)
		}
	}
	b, _ = json.Marshal(HivePageRowsRequest{ConnectionID: "c1", Database: "dw", Table: "t", Limit: 10, Offset: 0})
	m = map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table", "limit", "offset"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("HivePageRowsRequest JSON must expose %q, got %s", key, b)
		}
	}
	b, _ = json.Marshal(HiveAlterTableRequest{
		ConnectionID: "c1", Database: "dw", Table: "t",
		AddColumns:  []service.HiveColumnDef{{Name: "age", Type: "int", Comment: "年龄"}},
		DropColumns: []string{"name"},
	})
	m = map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table", "add_columns", "modify_columns", "drop_columns"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("HiveAlterTableRequest JSON must expose %q, got %s", key, b)
		}
	}
	adds, ok := m["add_columns"].([]any)
	if !ok || len(adds) != 1 {
		t.Fatalf("add_columns = %v", m["add_columns"])
	}
	col, ok := adds[0].(map[string]any)
	if !ok {
		t.Fatalf("add_columns[0] = %v", adds[0])
	}
	for _, key := range []string{"name", "type", "comment"} {
		if _, ok := col[key]; !ok {
			t.Fatalf("HiveColumnDef JSON must expose %q, got %s", key, b)
		}
	}
	b, _ = json.Marshal(HiveTableRequest{ConnectionID: "c1", Database: "dw", Table: "t"})
	m = map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("HiveTableRequest JSON must expose %q, got %s", key, b)
		}
	}
}
