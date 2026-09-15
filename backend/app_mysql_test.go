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

// fakeMysqlApp implements service.MysqlDataSource for app-layer tests; the
// MySQL driver has no offline fake server, so pooling bypasses dialing.
type fakeMysqlApp struct {
	dbs         []string
	tables      []model.MysqlTableInfo
	page        model.MysqlPageRowsResult
	pageTarget  string
	truncated   string
	truncateErr error
	execDB      string
	execSQL     string
	execResult  []model.MysqlStatementResult
	execErr     error
	previewOut  model.MysqlCellUpdatePreview
	previewErr  error
	updateErr   error
	previewArgs mysqlCellUpdateArgs
	updateArgs  mysqlCellUpdateArgs
}

// mysqlCellUpdateArgs records one cell-update delegation's arguments.
type mysqlCellUpdateArgs struct {
	database, table string
	set             model.MysqlCellValue
	where           []model.MysqlCellValue
}

func (f *fakeMysqlApp) Connect(context.Context) error { return nil }
func (f *fakeMysqlApp) Close() error                  { return nil }
func (f *fakeMysqlApp) GetName() string               { return "fake-mysql" }
func (f *fakeMysqlApp) GetType() string               { return string(model.ConnectionTypeMySQL) }
func (f *fakeMysqlApp) Databases(context.Context) ([]string, error) {
	return f.dbs, nil
}
func (f *fakeMysqlApp) Tables(_ context.Context, database string) ([]model.MysqlTableInfo, error) {
	f.pageTarget = "tables:" + database
	return f.tables, nil
}
func (f *fakeMysqlApp) PageRows(_ context.Context, database, table, _, _ string, _ bool, _, _ int) (model.MysqlPageRowsResult, error) {
	f.pageTarget = database + "." + table
	return f.page, nil
}
func (f *fakeMysqlApp) TruncateTable(_ context.Context, database, table string) error {
	f.truncated = database + "." + table
	return f.truncateErr
}
func (f *fakeMysqlApp) Execute(_ context.Context, database, sqlText string) ([]model.MysqlStatementResult, error) {
	f.execDB = database
	f.execSQL = sqlText
	return f.execResult, f.execErr
}
func (f *fakeMysqlApp) PreviewCellUpdate(_ context.Context, database, table string, set model.MysqlCellValue, where []model.MysqlCellValue) (model.MysqlCellUpdatePreview, error) {
	f.previewArgs = mysqlCellUpdateArgs{database: database, table: table, set: set, where: where}
	return f.previewOut, f.previewErr
}
func (f *fakeMysqlApp) UpdateCell(_ context.Context, database, table string, set model.MysqlCellValue, where []model.MysqlCellValue) error {
	f.updateArgs = mysqlCellUpdateArgs{database: database, table: table, set: set, where: where}
	return f.updateErr
}

var _ service.MysqlDataSource = (*fakeMysqlApp)(nil)

// newMysqlApp registers one connection (mysql or tidb) in the store and pools
// the given fake as its client (no network involved).
func newMysqlApp(t *testing.T, typ model.ConnectionType, fake *fakeMysqlApp) (*App, string) {
	t.Helper()
	app := newTestApp(t)
	conn, err := app.CreateConnection(&model.Connection{
		Name:   "mysql-local",
		Type:   typ,
		Config: model.MustConfigJSON(model.MysqlConfig{Host: "127.0.0.1", Port: 3306, Database: "app"}),
	})
	if err != nil {
		t.Fatalf("create mysql connection: %v", err)
	}
	if err := app.svc.PutPooledForTest(conn.ID, fake); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	return app, conn.ID
}

func TestAppMysqlBrowseFlow(t *testing.T) {
	rows := int64(9)
	fake := &fakeMysqlApp{
		dbs: []string{"app", "logs"},
		tables: []model.MysqlTableInfo{
			{Name: "users", Engine: "InnoDB", TableRows: &rows, Comment: "账号表"},
		},
		page: model.MysqlPageRowsResult{
			Columns: []model.MysqlColumn{
				{Name: "id", Type: "bigint", IsInPrimaryKey: true},
				{Name: "note", Type: "varchar(255)"},
			},
			Rows:       [][]*string{{strPtrOf("1"), nil}},
			TotalRows:  9,
			PrimaryKey: []string{"id"},
			Engine:     "InnoDB",
		},
	}
	app, connID := newMysqlApp(t, model.ConnectionTypeMySQL, fake)

	dbs, err := app.ListMysqlDatabases(connID)
	if err != nil || len(dbs) != 2 || dbs[0] != "app" {
		t.Fatalf("ListMysqlDatabases: %v %+v", err, dbs)
	}

	tables, err := app.ListMysqlTables(MysqlTablesRequest{ConnectionID: connID, Database: "app"})
	if err != nil || len(tables) != 1 || tables[0].Name != "users" || tables[0].Engine != "InnoDB" ||
		tables[0].TableRows == nil || *tables[0].TableRows != 9 || tables[0].Comment != "账号表" {
		t.Fatalf("ListMysqlTables: %v %+v", err, tables)
	}
	if fake.pageTarget != "tables:app" {
		t.Fatalf("tables must target the database, got %q", fake.pageTarget)
	}

	page, err := app.MysqlPageRows(MysqlPageRowsRequest{
		ConnectionID: connID, Database: "app", Table: "users",
		Where: "id > 0", OrderBy: "id", Asc: true, Limit: 50, Offset: 0,
	})
	if err != nil {
		t.Fatalf("MysqlPageRows: %v", err)
	}
	if len(page.Columns) != 2 || page.Columns[0].Type != "bigint" || !page.Columns[0].IsInPrimaryKey {
		t.Fatalf("unexpected columns: %+v", page.Columns)
	}
	if len(page.Rows) != 1 || page.Rows[0][0] == nil || *page.Rows[0][0] != "1" || page.Rows[0][1] != nil {
		t.Fatalf("unexpected rows: %+v", page.Rows)
	}
	if page.Engine != "InnoDB" || page.TotalRows != 9 || len(page.PrimaryKey) != 1 || page.PrimaryKey[0] != "id" {
		t.Fatalf("unexpected metadata: %+v", page)
	}
	if fake.pageTarget != "app.users" {
		t.Fatalf("page must target db.table, got %q", fake.pageTarget)
	}
}

// TestAppMysqlTidbTypeUsesSameBindings verifies a tidb-typed connection flows
// through the same MySQL bindings (one implementation, two types).
func TestAppMysqlTidbTypeUsesSameBindings(t *testing.T) {
	app, connID := newMysqlApp(t, model.ConnectionTypeTiDB, &fakeMysqlApp{dbs: []string{"shop"}})
	dbs, err := app.ListMysqlDatabases(connID)
	if err != nil || len(dbs) != 1 || dbs[0] != "shop" {
		t.Fatalf("ListMysqlDatabases via tidb: %v %+v", err, dbs)
	}
}

func TestAppMysqlTruncateTableAudited(t *testing.T) {
	fake := &fakeMysqlApp{}
	app, connID := newMysqlApp(t, model.ConnectionTypeMySQL, fake)

	if err := app.MysqlTruncateTable(MysqlTruncateTableRequest{ConnectionID: connID, Database: "app", Table: "users"}); err != nil {
		t.Fatalf("MysqlTruncateTable: %v", err)
	}
	if fake.truncated != "app.users" {
		t.Fatalf("unexpected delegation: %+v", fake)
	}

	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_truncate_table" || list[0].Target != "app.users" ||
		list[0].Result != "ok" || list[0].ConnectionID != connID {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	// 失败也要落审计(错误详情透出)。
	failApp, failID := newMysqlApp(t, model.ConnectionTypeMySQL, &fakeMysqlApp{truncateErr: errors.New("boom")})
	if err := failApp.MysqlTruncateTable(MysqlTruncateTableRequest{ConnectionID: failID, Database: "d", Table: "t"}); err == nil {
		t.Fatal("truncate failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_truncate_table" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed truncate must be audited: %+v", list[0])
	}
}

func TestAppMysqlExecuteAuditedWithCappedTarget(t *testing.T) {
	fake := &fakeMysqlApp{execResult: []model.MysqlStatementResult{
		{SQL: "SELECT 1", DurationMs: 2, Columns: []model.MysqlColumn{{Name: "1", Type: "bigint"}}, Rows: [][]*string{{strPtrOf("1")}}},
	}}
	app, connID := newMysqlApp(t, model.ConnectionTypeMySQL, fake)

	long := "SELECT " + strings.Repeat("x", 80)
	results, err := app.MysqlExecute(MysqlExecuteRequest{ConnectionID: connID, SQL: long})
	if err != nil || len(results) != 1 || results[0].SQL != "SELECT 1" {
		t.Fatalf("MysqlExecute: %v %+v", err, results)
	}
	if fake.execSQL != long {
		t.Fatalf("sql must be delegated verbatim")
	}

	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	e := list[0]
	if e.Action != "mysql_execute" || e.Result != "ok" {
		t.Fatalf("unexpected audit: %+v", e)
	}
	if e.Target != long[:60] {
		t.Fatalf("target must be the first 60 chars, got %q want %q", e.Target, long[:60])
	}
}

// TestAppMysqlExecutePassesDatabase 控制台的当前库必须原样透传到执行层。
func TestAppMysqlExecutePassesDatabase(t *testing.T) {
	fake := &fakeMysqlApp{}
	app, connID := newMysqlApp(t, model.ConnectionTypeMySQL, fake)
	if _, err := app.MysqlExecute(MysqlExecuteRequest{ConnectionID: connID, Database: "订单库", SQL: "SELECT 1"}); err != nil {
		t.Fatalf("MysqlExecute: %v", err)
	}
	if fake.execDB != "订单库" || fake.execSQL != "SELECT 1" {
		t.Fatalf("database/sql must pass through: db=%q sql=%q", fake.execDB, fake.execSQL)
	}
	// 空 database 同样透传(空串 = 不发 USE,走连接池默认上下文)。
	if _, err := app.MysqlExecute(MysqlExecuteRequest{ConnectionID: connID, SQL: "SELECT 2"}); err != nil {
		t.Fatalf("MysqlExecute without database: %v", err)
	}
	if fake.execDB != "" || fake.execSQL != "SELECT 2" {
		t.Fatalf("empty database must pass through as empty: db=%q sql=%q", fake.execDB, fake.execSQL)
	}
}

func TestAppMysqlExecuteFailureAudited(t *testing.T) {
	app, connID := newMysqlApp(t, model.ConnectionTypeMySQL, &fakeMysqlApp{execErr: errors.New("boom")})
	if _, err := app.MysqlExecute(MysqlExecuteRequest{ConnectionID: connID, SQL: "SELECT 1"}); err == nil {
		t.Fatal("execute failure must surface")
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_execute" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed execute must be audited: %+v", list[0])
	}
}

func TestAppTestMysqlConnectionValidates(t *testing.T) {
	app := newTestApp(t)
	if err := app.TestMysqlConnection(model.MysqlConfig{Port: 3306}); err == nil {
		t.Fatal("empty host must fail before dialing")
	}
	if err := app.TestMysqlConnection(model.MysqlConfig{Host: "h", Port: 70000}); err == nil {
		t.Fatal("out-of-range port must fail before dialing")
	}
	if err := app.TestMysqlConnection(model.MysqlConfig{Host: "h", TLSMode: "bogus"}); err == nil {
		t.Fatal("unknown tls_mode must fail before dialing")
	}
}

// TestAppMysqlPreviewCellUpdate 预览只读:参数透传、结果原样返回、不落审计。
func TestAppMysqlPreviewCellUpdate(t *testing.T) {
	fake := &fakeMysqlApp{previewOut: model.MysqlCellUpdatePreview{
		Statement:   "UPDATE `app`.`users` SET `note` = 'x' WHERE `id` = '1'",
		MatchedRows: 1,
	}}
	app, connID := newMysqlApp(t, model.ConnectionTypeMySQL, fake)
	set := model.MysqlCellValue{Column: "note", Value: strPtrOf("x")}
	where := []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}}

	prev, err := app.MysqlPreviewCellUpdate(model.MysqlCellUpdateRequest{
		ConnectionID: connID, Database: "app", Table: "users", Set: set, Where: where,
	})
	if err != nil {
		t.Fatalf("MysqlPreviewCellUpdate: %v", err)
	}
	if prev.Statement != fake.previewOut.Statement || prev.MatchedRows != 1 {
		t.Fatalf("unexpected preview: %+v", prev)
	}
	if fake.previewArgs.database != "app" || fake.previewArgs.table != "users" ||
		fake.previewArgs.set.Column != "note" || len(fake.previewArgs.where) != 1 {
		t.Fatalf("preview args must pass through: %+v", fake.previewArgs)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	// 只读预览不落审计(列表里只允许有建连时的 create_connection)。
	for _, e := range list {
		if strings.Contains(e.Action, "cell") {
			t.Fatalf("read-only preview must not be audited, got %+v", list)
		}
	}
}

// TestAppMysqlUpdateCellAudited 执行走审计:成功 ok,失败 error + 错误详情,
// 与 MysqlTruncateTable 同风格(action/target 为 db.table)。
func TestAppMysqlUpdateCellAudited(t *testing.T) {
	fake := &fakeMysqlApp{}
	app, connID := newMysqlApp(t, model.ConnectionTypeMySQL, fake)
	req := model.MysqlCellUpdateRequest{
		ConnectionID: connID, Database: "app", Table: "users",
		Set:   model.MysqlCellValue{Column: "note", Value: strPtrOf("x")},
		Where: []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}},
	}

	if err := app.MysqlUpdateCell(req); err != nil {
		t.Fatalf("MysqlUpdateCell: %v", err)
	}
	if fake.updateArgs.database != "app" || fake.updateArgs.table != "users" || fake.updateArgs.set.Column != "note" {
		t.Fatalf("update args must pass through: %+v", fake.updateArgs)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_update_cell" || list[0].Target != "app.users" ||
		list[0].Result != "ok" || list[0].ConnectionID != connID {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	// 失败也要落审计(错误详情透出)。
	failApp, failID := newMysqlApp(t, model.ConnectionTypeMySQL, &fakeMysqlApp{updateErr: errors.New("boom")})
	req.ConnectionID = failID
	if err := failApp.MysqlUpdateCell(req); err == nil {
		t.Fatal("update failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_update_cell" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed update must be audited: %+v", list[0])
	}
}

// TestAppMysqlRequestJSONShapes 锁定 wire 契约:请求字段全部 snake_case。
func TestAppMysqlRequestJSONShapes(t *testing.T) {
	b, err := json.Marshal(MysqlTablesRequest{ConnectionID: "c", Database: "d"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlTablesRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(MysqlPageRowsRequest{ConnectionID: "c", Database: "d", Table: "t", Where: "x > 1", OrderBy: "id", Limit: 1, Offset: 2})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table", "where", "order_by", "asc", "limit", "offset"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlPageRowsRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(MysqlTruncateTableRequest{ConnectionID: "c", Database: "d", Table: "t"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlTruncateTableRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(MysqlExecuteRequest{ConnectionID: "c", Database: "app", SQL: "SELECT 1"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "sql"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlExecuteRequest JSON must expose %q, got %s", key, b)
		}
	}
	// database 为空时不得出现在 JSON(omitempty)。
	b, err = json.Marshal(MysqlExecuteRequest{ConnectionID: "c", SQL: "SELECT 1"})
	if err != nil {
		t.Fatalf("marshal empty: %v", err)
	}
	if strings.Contains(string(b), "database") {
		t.Fatalf("empty database must be omitted from the JSON, got %s", b)
	}
}

// TestAppListDriversIncludesMysqlAndTiDB 驱动注册表必须登记 MySQL 与 TiDB,
// 两者共用 go-sql-driver/mysql 实现,默认端口分别为 3306/4000。
func TestAppListDriversIncludesMysqlAndTiDB(t *testing.T) {
	app := newTestApp(t)
	drivers, err := app.ListDrivers()
	if err != nil {
		t.Fatalf("ListDrivers: %v", err)
	}
	want := map[string]DriverInfo{
		"MySQL": {Name: "MySQL", Library: "go-sql-driver/mysql", Version: "v1.10.1", DefaultPort: 3306},
		"TiDB":  {Name: "TiDB", Library: "go-sql-driver/mysql", Version: "v1.10.1", DefaultPort: 4000},
	}
	found := 0
	for _, d := range drivers {
		w, ok := want[d.Name]
		if !ok {
			continue
		}
		found++
		if d.Library != w.Library || d.Version != w.Version || d.DefaultPort != w.DefaultPort || d.Description == "" {
			t.Fatalf("unexpected driver fields: %+v (want %s/%s/%d)", d, w.Library, w.Version, w.DefaultPort)
		}
	}
	if found != 2 {
		t.Fatalf("MySQL and TiDB must both be registered, found %d in %+v", found, drivers)
	}
}
