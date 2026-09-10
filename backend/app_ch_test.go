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

// fakeCHApp implements service.ClickHouseDataSource for app-layer tests; the
// ClickHouse driver has no offline fake server, so pooling bypasses dialing.
type fakeCHApp struct {
	dbs         []string
	tables      []model.CHTableInfo
	page        model.CHPageRowsResult
	pageTarget  string
	truncated   string
	clusterArg  bool
	execSQL     string
	execResult  []model.CHStatementResult
	execErr     error
	truncateErr error
}

func (f *fakeCHApp) Connect(context.Context) error { return nil }
func (f *fakeCHApp) Close() error                  { return nil }
func (f *fakeCHApp) GetName() string               { return "fake-ch" }
func (f *fakeCHApp) GetType() string               { return string(model.ConnectionTypeClickHouse) }
func (f *fakeCHApp) Databases(context.Context) ([]string, error) {
	return f.dbs, nil
}
func (f *fakeCHApp) Tables(_ context.Context, database string, showSystem bool) ([]model.CHTableInfo, error) {
	f.pageTarget = "tables:" + database
	if showSystem {
		f.pageTarget += ":system"
	}
	return f.tables, nil
}
func (f *fakeCHApp) PageRows(_ context.Context, database, table, _, _ string, _ bool, _, _ int) (model.CHPageRowsResult, error) {
	f.pageTarget = database + "." + table
	return f.page, nil
}
func (f *fakeCHApp) TruncateTable(_ context.Context, database, table string, onCluster bool) error {
	f.truncated = database + "." + table
	f.clusterArg = onCluster
	return f.truncateErr
}
func (f *fakeCHApp) Execute(_ context.Context, sqlText string) ([]model.CHStatementResult, error) {
	f.execSQL = sqlText
	return f.execResult, f.execErr
}

var _ service.ClickHouseDataSource = (*fakeCHApp)(nil)

// newCHApp registers one clickhouse connection in the store and pools the
// given fake as its client (no network involved).
func newCHApp(t *testing.T, fake *fakeCHApp) (*App, string) {
	t.Helper()
	app := newTestApp(t)
	conn, err := app.CreateConnection(&model.Connection{
		Name:   "ch-local",
		Type:   model.ConnectionTypeClickHouse,
		Config: model.MustConfigJSON(model.ClickHouseConfig{Hosts: []string{"127.0.0.1:9000"}}),
	})
	if err != nil {
		t.Fatalf("create clickhouse connection: %v", err)
	}
	if err := app.svc.PutPooledForTest(conn.ID, fake); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	return app, conn.ID
}

func TestAppCHBrowseFlow(t *testing.T) {
	total := int64(7)
	fake := &fakeCHApp{
		dbs:    []string{"default", "logs"},
		tables: []model.CHTableInfo{{Name: "events", Engine: "MergeTree", TotalRows: &total}},
		page: model.CHPageRowsResult{
			Columns:   []model.CHColumn{{Name: "id", Type: "UInt64"}, {Name: "note", Type: "Nullable(String)"}},
			Rows:      [][]*string{{strPtrOf("1"), nil}},
			Engine:    "MergeTree",
			TotalRows: &total,
		},
	}
	app, connID := newCHApp(t, fake)

	dbs, err := app.ListCHDatabases(connID)
	if err != nil || len(dbs) != 2 || dbs[0] != "default" {
		t.Fatalf("ListCHDatabases: %v %+v", err, dbs)
	}

	tables, err := app.ListCHTables(CHTablesRequest{ConnectionID: connID, Database: "logs", ShowSystem: false})
	if err != nil || len(tables) != 1 || tables[0].Name != "events" || tables[0].Engine != "MergeTree" ||
		tables[0].TotalRows == nil || *tables[0].TotalRows != 7 {
		t.Fatalf("ListCHTables: %v %+v", err, tables)
	}

	page, err := app.CHPageRows(CHPageRowsRequest{
		ConnectionID: connID, Database: "logs", Table: "events",
		Where: "id > 0", OrderBy: "id", Asc: true, Limit: 50, Offset: 0,
	})
	if err != nil {
		t.Fatalf("CHPageRows: %v", err)
	}
	if len(page.Columns) != 2 || page.Columns[1].Type != "Nullable(String)" {
		t.Fatalf("unexpected columns: %+v", page.Columns)
	}
	if len(page.Rows) != 1 || page.Rows[0][0] == nil || *page.Rows[0][0] != "1" || page.Rows[0][1] != nil {
		t.Fatalf("unexpected rows: %+v", page.Rows)
	}
	if page.Engine != "MergeTree" || page.TotalRows == nil || *page.TotalRows != 7 {
		t.Fatalf("unexpected metadata: %+v", page)
	}
	if fake.pageTarget != "logs.events" {
		t.Fatalf("page must target db.table, got %q", fake.pageTarget)
	}
}

func TestAppCHTruncateTableAudited(t *testing.T) {
	fake := &fakeCHApp{}
	app, connID := newCHApp(t, fake)

	if err := app.CHTruncateTable(CHTruncateTableRequest{ConnectionID: connID, Database: "logs", Table: "events", OnCluster: true}); err != nil {
		t.Fatalf("CHTruncateTable: %v", err)
	}
	if fake.truncated != "logs.events" || !fake.clusterArg {
		t.Fatalf("unexpected delegation: %+v", fake)
	}

	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "ch_truncate_table" || list[0].Target != "logs.events" ||
		list[0].Result != "ok" || list[0].ConnectionID != connID {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	// 失败也要落审计(错误详情透出)。
	failApp, failID := newCHApp(t, &fakeCHApp{truncateErr: errors.New("boom")})
	if err := failApp.CHTruncateTable(CHTruncateTableRequest{ConnectionID: failID, Database: "d", Table: "t"}); err == nil {
		t.Fatal("truncate failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "ch_truncate_table" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed truncate must be audited: %+v", list[0])
	}
}

func TestAppCHExecuteAuditedWithCappedTarget(t *testing.T) {
	fake := &fakeCHApp{execResult: []model.CHStatementResult{
		{SQL: "SELECT 1", DurationMs: 2, Columns: []model.CHColumn{{Name: "1", Type: "UInt8"}}, Rows: [][]*string{{strPtrOf("1")}}},
	}}
	app, connID := newCHApp(t, fake)

	long := "SELECT " + strings.Repeat("x", 80)
	results, err := app.CHExecute(CHExecuteRequest{ConnectionID: connID, SQL: long})
	if err != nil || len(results) != 1 || results[0].SQL != "SELECT 1" {
		t.Fatalf("CHExecute: %v %+v", err, results)
	}
	if fake.execSQL != long {
		t.Fatalf("sql must be delegated verbatim")
	}

	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	e := list[0]
	if e.Action != "ch_execute" || e.Result != "ok" {
		t.Fatalf("unexpected audit: %+v", e)
	}
	if e.Target != long[:60] {
		t.Fatalf("target must be the first 60 chars, got %q want %q", e.Target, long[:60])
	}
}

func TestAppCHExecuteFailureAudited(t *testing.T) {
	app, connID := newCHApp(t, &fakeCHApp{execErr: errors.New("boom")})
	if _, err := app.CHExecute(CHExecuteRequest{ConnectionID: connID, SQL: "SELECT 1"}); err == nil {
		t.Fatal("execute failure must surface")
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "ch_execute" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed execute must be audited: %+v", list[0])
	}
}

func TestAppTestCHConnectionValidates(t *testing.T) {
	app := newTestApp(t)
	if err := app.TestCHConnection(model.ClickHouseConfig{Hosts: []string{"no-port"}}); err == nil {
		t.Fatal("invalid config must fail before dialing")
	}
	if err := app.TestCHConnection(model.ClickHouseConfig{}); err == nil {
		t.Fatal("empty hosts must fail before dialing")
	}
}

func TestAppListDriversStatic(t *testing.T) {
	app := newTestApp(t)
	drivers, err := app.ListDrivers()
	if err != nil {
		t.Fatalf("ListDrivers: %v", err)
	}
	if len(drivers) != 3 {
		t.Fatalf("expected 3 builtin drivers, got %+v", drivers)
	}
	want := map[string]DriverInfo{
		"Kafka":      {Name: "Kafka", Library: "franz-go", Version: "v1.21.6", DefaultPort: 9092},
		"Redis":      {Name: "Redis", Library: "go-redis", Version: "v9.22.0", DefaultPort: 6379},
		"ClickHouse": {Name: "ClickHouse", Library: "clickhouse-go", Version: "v2.48.0", DefaultPort: 9000},
	}
	for _, d := range drivers {
		w, ok := want[d.Name]
		if !ok {
			t.Fatalf("unexpected driver %+v", d)
		}
		if d.Library != w.Library || d.Version != w.Version || d.DefaultPort != w.DefaultPort || d.Description == "" {
			t.Fatalf("unexpected driver fields: %+v (want %s/%s/%d)", d, w.Library, w.Version, w.DefaultPort)
		}
	}
}

// TestCHRequestJSONShapes 锁定 wire 契约:请求字段全部 snake_case。
func TestCHRequestJSONShapes(t *testing.T) {
	b, err := json.Marshal(CHTablesRequest{ConnectionID: "c", Database: "d", ShowSystem: true})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "show_system"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("CHTablesRequest JSON must expose %q, got %s", key, b)
		}
	}

	// where/order_by 是可选字段(omitempty),填值后必须以 snake_case 出现。
	b, err = json.Marshal(CHPageRowsRequest{ConnectionID: "c", Database: "d", Table: "t", Where: "x > 1", OrderBy: "id", Limit: 1, Offset: 2})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table", "where", "order_by", "asc", "limit", "offset"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("CHPageRowsRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(CHTruncateTableRequest{ConnectionID: "c", Database: "d", Table: "t", OnCluster: true})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table", "on_cluster"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("CHTruncateTableRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(CHExecuteRequest{ConnectionID: "c", SQL: "SELECT 1"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "sql"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("CHExecuteRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(DriverInfo{Name: "Kafka", Library: "franz-go", Version: "v1.21.6", DefaultPort: 9092, Description: "d"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"name", "library", "version", "default_port", "description"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("DriverInfo JSON must expose %q, got %s", key, b)
		}
	}
}

func strPtrOf(s string) *string { return &s }
