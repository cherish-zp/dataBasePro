package backend

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/service"
)

// --- App 层离线 fake 驱动:实现 QueryerContext/ExecerContext,按查询文本
// 路由 SHOW CREATE TABLE 与数据页;exec 记录 DROP/ALTER 语句文本。 ---

type appDdlDriver struct{}

func (appDdlDriver) Open(string) (driver.Conn, error) { return nil, errors.New("use sql.OpenDB") }

type appDdlConn struct {
	execs   []string
	execErr error
	respond func(query string) (driver.Rows, error)
}

func (c *appDdlConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare unsupported")
}
func (c *appDdlConn) Close() error              { return nil }
func (c *appDdlConn) Begin() (driver.Tx, error) { return nil, errors.New("transactions unsupported") }

func (c *appDdlConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	if c.execErr != nil {
		return nil, c.execErr
	}
	c.execs = append(c.execs, query)
	return driver.RowsAffected(0), nil
}

func (c *appDdlConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if c.respond == nil {
		return &appDdlRows{cols: []string{"x"}}, nil
	}
	return c.respond(query)
}

type appDdlRows struct {
	cols []string
	vals [][]driver.Value
	pos  int
}

func (r *appDdlRows) Columns() []string { return r.cols }
func (r *appDdlRows) Close() error      { return nil }
func (r *appDdlRows) Next(dest []driver.Value) error {
	if r.pos >= len(r.vals) {
		return io.EOF
	}
	copy(dest, r.vals[r.pos])
	r.pos++
	return nil
}

type appDdlConnector struct{ conn *appDdlConn }

func (c appDdlConnector) Connect(context.Context) (driver.Conn, error) { return c.conn, nil }
func (c appDdlConnector) Driver() driver.Driver                        { return appDdlDriver{} }

// newMysqlDdlApp registers a mysql connection and pools a real *MysqlClient
// backed by the offline fake driver (no network involved).
func newMysqlDdlApp(t *testing.T, conn *appDdlConn) (*App, string) {
	t.Helper()
	app := newTestApp(t)
	rec, err := app.CreateConnection(&model.Connection{
		Name:   "mysql-local",
		Type:   model.ConnectionTypeMySQL,
		Config: model.MustConfigJSON(model.MysqlConfig{Host: "127.0.0.1", Port: 3306, Database: "app"}),
	})
	if err != nil {
		t.Fatalf("create mysql connection: %v", err)
	}
	client := service.NewMysqlClientWithConnector(appDdlConnector{conn: conn}, model.ConnectionTypeMySQL)
	t.Cleanup(func() { _ = client.Close() })
	if err := app.svc.PutPooledForTest(rec.ID, client); err != nil {
		t.Fatalf("pool client: %v", err)
	}
	// 导出走独立 builder 而非池客户端(见 Service.MysqlExportTable):测试同样
	// 注入,返回同一 fake 客户端,让 drop/columns/export 共用本脚手架。
	app.svc.SetMysqlExportClientBuilderForTest(func(*model.Connection) (*service.MysqlClient, error) {
		return client, nil
	})
	return app, rec.ID
}

// TestAppMysqlDropTableAudited drops through the binding and audits both the
// success and the failure, matching truncate's audit style.
func TestAppMysqlDropTableAudited(t *testing.T) {
	conn := &appDdlConn{}
	app, connID := newMysqlDdlApp(t, conn)

	if err := app.MysqlDropTable(MysqlDropTableRequest{ConnectionID: connID, Database: "app", Table: "users"}); err != nil {
		t.Fatalf("MysqlDropTable: %v", err)
	}
	if len(conn.execs) != 1 || conn.execs[0] != "DROP TABLE `app`.`users`" {
		t.Fatalf("unexpected execs: %+v", conn.execs)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_drop_table" || list[0].Target != "app.users" ||
		list[0].Result != "ok" || list[0].ConnectionID != connID {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	// 失败也要落审计(错误详情透出)。
	failConn := &appDdlConn{execErr: errors.New("boom")}
	failApp, failID := newMysqlDdlApp(t, failConn)
	if err := failApp.MysqlDropTable(MysqlDropTableRequest{ConnectionID: failID, Database: "d", Table: "t"}); err == nil {
		t.Fatal("drop failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_drop_table" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed drop must be audited: %+v", list[0])
	}
}

// TestAppMysqlExportTableAudited exports structure + data through the binding.
func TestAppMysqlExportTableAudited(t *testing.T) {
	conn := &appDdlConn{respond: func(query string) (driver.Rows, error) {
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			return &appDdlRows{
				cols: []string{"Table", "Create Table"},
				vals: [][]driver.Value{{"users", "CREATE TABLE `users` (`id` int)"}},
			}, nil
		}
		if strings.Contains(query, "information_schema.key_column_usage") {
			return &appDdlRows{cols: []string{"column_name"}}, nil
		}
		if strings.HasPrefix(query, "SELECT * FROM") {
			return &appDdlRows{cols: []string{"id"}, vals: [][]driver.Value{{int64(1)}, {nil}}}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	}}
	app, connID := newMysqlDdlApp(t, conn)

	res, err := app.MysqlExportTable(MysqlExportTableRequest{ConnectionID: connID, Database: "app", Table: "users", IncludeData: true, IncludeDDL: true, DataLimit: 0})
	if err != nil {
		t.Fatalf("MysqlExportTable: %v", err)
	}
	if !strings.HasPrefix(res.Filename, "users_") || !strings.HasSuffix(res.Filename, ".sql") {
		t.Fatalf("unexpected filename %q", res.Filename)
	}
	for _, want := range []string{"CREATE TABLE `users` (`id` int);", "INSERT INTO `app`.`users` (`id`) VALUES ", "(1)", "(NULL)"} {
		if !strings.Contains(res.Content, want) {
			t.Fatalf("content must contain %q, got:\n%s", want, res.Content)
		}
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_export_table" || list[0].Target != "app.users" || list[0].Result != "ok" {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	// 失败也要落审计(带 include_ddl,因查询失败而非校验失败落 error)。
	failConn := &appDdlConn{respond: func(string) (driver.Rows, error) { return nil, errors.New("boom") }}
	failApp, failID := newMysqlDdlApp(t, failConn)
	if _, err := failApp.MysqlExportTable(MysqlExportTableRequest{ConnectionID: failID, Database: "app", Table: "users", IncludeDDL: true}); err == nil {
		t.Fatal("export failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_export_table" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed export must be audited: %+v", list[0])
	}
}

// TestAppMysqlDdlRequestJSONShapes locks the wire contract: request fields are
// all snake_case and match the hand-written frontend types.
func TestAppMysqlDdlRequestJSONShapes(t *testing.T) {
	b, err := json.Marshal(MysqlDropTableRequest{ConnectionID: "c", Database: "d", Table: "t"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlDropTableRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(MysqlTableColumnsRequest{ConnectionID: "c", Database: "d", Table: "t"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlTableColumnsRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(MysqlAlterTableRequest{
		ConnectionID: "c", Database: "d", Table: "t",
		AddColumns:    []service.MysqlColumnDef{{Name: "c1", ColumnType: "int", After: nil}},
		ModifyColumns: []service.MysqlColumnDef{{Name: "c1", ColumnType: "bigint", DefaultValue: nil, AutoIncrement: true}},
		DropColumns:   []string{"c2"},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table", "add_columns", "modify_columns", "drop_columns",
		"name", "column_type", "nullable", "default_value", "comment", "auto_increment"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlAlterTableRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(MysqlExportTableRequest{
		ConnectionID: "c", Database: "d", Table: "t",
		IncludeData: true, IncludeDDL: true, InsertPerRow: true,
		DropTableIfExists: true, StripAutoIncrement: true, IncludeCreateDB: true,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table", "include_data",
		"include_ddl", "insert_per_row", "drop_table_if_exists", "strip_auto_increment", "include_create_db"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlExportTableRequest JSON must expose %q, got %s", key, b)
		}
	}
	// data_limit 为 0 时不得出现在 JSON(omitempty)。
	b, err = json.Marshal(MysqlExportTableRequest{ConnectionID: "c", Database: "d", Table: "t"})
	if err != nil {
		t.Fatalf("marshal empty: %v", err)
	}
	if strings.Contains(string(b), "data_limit") {
		t.Fatalf("zero data_limit must be omitted from the JSON, got %s", b)
	}
}
