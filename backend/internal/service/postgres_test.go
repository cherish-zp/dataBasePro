package service

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"sheng-shou-yun-he/backend/internal/model"
	"sheng-shou-yun-he/backend/internal/store"
)

func TestBuildPostgresDSN(t *testing.T) {
	cfg := model.PostgresConfig{
		Host: "db.example", Port: 5433, Username: "user:one", Password: "p@ss word",
		Database: "app", TLSMode: model.PostgresTLSRequire, SearchPath: "public,app data",
		ConnectTimeoutMs: 1200,
	}
	got := buildPostgresDSN(cfg, "analytics")
	for _, want := range []string{
		"postgres://", "db.example:5433/analytics", "user%3Aone:p%40ss%20word@",
		"sslmode=require", "search_path=public%2Capp+data", "connect_timeout=2",
	} {
		if !containsToken(got, want) {
			t.Fatalf("DSN %q must contain %q", got, want)
		}
	}
	cfg.Database = "app"
	if got = buildPostgresDSN(cfg, ""); got == "" || !containsToken(got, "/app?") {
		t.Fatalf("empty database must fall back to config database, got %q", got)
	}
}

func TestPostgresQuoteIdentAndQualifiedName(t *testing.T) {
	got := postgresQuoteIdent(`we"ird`)
	if got != `"we""ird"` {
		t.Fatalf("quote = %q", got)
	}
	got = postgresQualifiedName("billing", "orders")
	if got != `"billing"."orders"` {
		t.Fatalf("qualified = %q", got)
	}
	if strings.Contains(got, `"app".`) {
		t.Fatalf("qualified name must never include a database prefix: %q", got)
	}
}

func TestPostgresGeneratedSQLNeverUsesThreePartNames(t *testing.T) {
	pageSQL := buildPostgresPageRowsSQL("app", "public", "users", "", "", true, 10, 0)
	if strings.Contains(pageSQL, `"app"`) || strings.Contains(pageSQL, `"public"."users"`) == false {
		t.Fatalf("page SQL must use schema.relation only, got %q", pageSQL)
	}
	set := model.PostgresCellValue{Column: "note", Value: strP("x")}
	where := []model.PostgresCellValue{{Column: "id", Value: strP("1")}}
	updateSQL, _, err := buildPostgresCellUpdateStatement("app", "public", "users", set, where, []string{"id"})
	if err != nil {
		t.Fatalf("cell update: %v", err)
	}
	if strings.Contains(updateSQL, `"app"`) {
		t.Fatalf("update SQL must use schema.relation only, got %q", updateSQL)
	}
	countSQL, _, err := buildPostgresCellCountStatement("app", "public", "users", where, []string{"id"})
	if err != nil {
		t.Fatalf("cell count: %v", err)
	}
	if strings.Contains(countSQL, `"app"`) {
		t.Fatalf("count SQL must use schema.relation only, got %q", countSQL)
	}
}

func TestBuildPostgresPageRowsSQL(t *testing.T) {
	got := buildPostgresPageRowsSQL("app", "public", "users", "active = true", "created_at", true, 20, 40)
	want := `SELECT * FROM "public"."users" WHERE active = true ORDER BY "created_at" ASC LIMIT 20 OFFSET 40`
	if got != want {
		t.Fatalf("page sql = %q, want %q", got, want)
	}
	got = buildPostgresPageRowsSQL("app", "public", "users", "", "", false, 10, 0)
	if got != `SELECT * FROM "public"."users" LIMIT 10 OFFSET 0` {
		t.Fatalf("simple page sql = %q", got)
	}
}

func TestBuildPostgresCellUpdateStatement(t *testing.T) {
	set := model.PostgresCellValue{Column: "note", Value: strP("x")}
	where := []model.PostgresCellValue{{Column: "id", Value: strP("1")}}
	updateSQL, updateArgs, err := buildPostgresCellUpdateStatement("app", "public", "users", set, where, []string{"id"})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if updateSQL != `UPDATE "public"."users" SET "note" = $1 WHERE "id" = $2` {
		t.Fatalf("sql = %q", updateSQL)
	}
	if len(updateArgs) != 2 || mustString(updateArgs[0]) != "x" || mustString(updateArgs[1]) != "1" {
		t.Fatalf("args = %#v", updateArgs)
	}
	if _, _, err := buildPostgresCellUpdateStatement("app", "public", "users", set, nil, []string{"id"}); err == nil {
		t.Fatal("empty where must fail")
	}
	if _, _, err := buildPostgresCellUpdateStatement("app", "public", "users", set, []model.PostgresCellValue{{Column: "name", Value: strP("x")}}, []string{"id"}); err == nil {
		t.Fatal("non-primary-key where must fail")
	}
}

type fakePostgres struct {
	fakeDataSource
	dbs         []string
	schemas     []string
	tables      []model.PostgresTableInfo
	page        model.PostgresPageRowsResult
	pageCall    string
	truncated   string
	execSQL     string
	execLimit   int
	execOffset  int
	execResult  []model.PostgresStatementResult
	previewCall *model.PostgresCellUpdateRequest
	previewOut  model.PostgresCellUpdatePreview
	updateCall  *model.PostgresCellUpdateRequest
	updateErr   error
}

func (f *fakePostgres) Databases(context.Context) ([]string, error) { return f.dbs, nil }
func (f *fakePostgres) Schemas(_ context.Context, database string) ([]string, error) {
	f.pageCall = database
	return f.schemas, nil
}
func (f *fakePostgres) Tables(_ context.Context, database, schema string) ([]model.PostgresTableInfo, error) {
	f.pageCall = database + "." + schema
	return f.tables, nil
}
func (f *fakePostgres) PageRows(_ context.Context, database, schema, relation, kind, where, orderBy string, asc bool, limit, offset int) (model.PostgresPageRowsResult, error) {
	f.pageCall = database + "." + schema + "." + relation + ":" + kind + ":" + where + ":" + orderBy
	return f.page, nil
}
func (f *fakePostgres) Execute(_ context.Context, database, schema, sqlText string, limit, offset int) ([]model.PostgresStatementResult, error) {
	f.execSQL = database + "|" + schema + "|" + sqlText
	f.execLimit, f.execOffset = limit, offset
	return f.execResult, nil
}
func (f *fakePostgres) TruncateTable(_ context.Context, database, schema, relation, kind string) error {
	f.truncated = database + "." + schema + "." + relation + ":" + kind
	return nil
}
func (f *fakePostgres) PreviewCellUpdate(_ context.Context, req model.PostgresCellUpdateRequest) (model.PostgresCellUpdatePreview, error) {
	f.previewCall = &req
	return f.previewOut, nil
}
func (f *fakePostgres) UpdateCell(_ context.Context, req model.PostgresCellUpdateRequest) error {
	f.updateCall = &req
	return f.updateErr
}

func containsToken(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}

func TestSplitPostgresStatements(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{
			"dollar quoted body keeps semicolons",
			"CREATE FUNCTION f() RETURNS void AS $$ BEGIN x := 1; y := 2; END; $$ LANGUAGE plpgsql; SELECT 1",
			[]string{"CREATE FUNCTION f() RETURNS void AS $$ BEGIN x := 1; y := 2; END; $$ LANGUAGE plpgsql", "SELECT 1"},
		},
		{
			"parameter placeholders are not dollar quotes",
			"SELECT $1, $2; SELECT $3",
			[]string{"SELECT $1, $2", "SELECT $3"},
		},
		{
			"tagged dollar quote and nested dollar",
			"DO $body$ SELECT '$$'; SELECT 1; $body$; SELECT 2",
			[]string{`DO $body$ SELECT '$$'; SELECT 1; $body$`, "SELECT 2"},
		},
		{
			"standard strings treat only doubled quote as escape",
			"SELECT 'a;b\\''c' AS one; SELECT 'x\\;y' AS two",
			[]string{`SELECT 'a;b\''c' AS one`, `SELECT 'x\;y' AS two`},
		},
		{
			"backslash does not escape a standard string terminator",
			"SELECT '\\'; SELECT 1",
			[]string{`SELECT '\'`, "SELECT 1"},
		},
		{
			"escape strings handle backslash",
			"E'first;\\'second'; SELECT 1",
			[]string{`E'first;\'second'`, "SELECT 1"},
		},
	}
	for _, tc := range cases {
		got := SplitPostgresStatements(tc.in)
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s: got %#v, want %#v", tc.name, got, tc.want)
		}
	}
}

func TestNewPostgresTableInfoUsesSemanticRelationType(t *testing.T) {
	cases := []struct {
		raw  string
		kind model.PostgresRelationKind
	}{
		{"r", model.PostgresRelationKindTable},
		{"p", model.PostgresRelationKindTable},
		{"f", model.PostgresRelationKindTable},
		{"v", model.PostgresRelationKindView},
		{"m", model.PostgresRelationKindMaterializedView},
	}
	for _, tc := range cases {
		info := newPostgresTableInfo("public", "users", tc.raw, []string{"id"}, "")
		if info.Relation != "users" || info.Schema != "public" || info.RelationType != string(tc.kind) || info.RelationKind != tc.kind || info.RawRelationType != tc.raw {
			t.Fatalf("raw %q produced %+v, want relation_type/kind %q", tc.raw, info, tc.kind)
		}
	}
}

func TestPostgresClientRejectsNonTableCellEdit(t *testing.T) {
	client := &PostgresClient{}
	req := model.PostgresCellUpdateRequest{
		Relation: "users", RelationKind: model.PostgresRelationKindView,
	}
	if _, err := client.PreviewCellUpdate(context.Background(), req); err == nil || !strings.Contains(err.Error(), "不可编辑") {
		t.Fatalf("view preview must be rejected before dialing, got %v", err)
	}
	req.RelationKind = model.PostgresRelationKindMaterializedView
	if err := client.UpdateCell(context.Background(), req); err == nil || !strings.Contains(err.Error(), "不可编辑") {
		t.Fatalf("materialized view update must be rejected before dialing, got %v", err)
	}
	req.RelationKind = ""
	if err := client.UpdateCell(context.Background(), req); err == nil {
		t.Fatal("empty relation_kind must be rejected for cell edit")
	}
}

func TestPostgresStatementReturnsRowsForContract(t *testing.T) {
	if !postgresStatementReturnsRows("SELECT 1") || !postgresStatementReturnsRows("WITH x AS (SELECT 1) SELECT * FROM x") {
		t.Fatal("query statements must be marked as rows")
	}
	if postgresStatementReturnsRows("UPDATE users SET id = id") || postgresStatementReturnsRows("TRUNCATE users") {
		t.Fatal("non-query statements must not be marked as rows")
	}
}

func mustString(v any) string {
	switch value := v.(type) {
	case string:
		return value
	case *string:
		if value == nil {
			return ""
		}
		return *value
	default:
		return ""
	}
}

func newTestServiceWithPostgres(t *testing.T, fake *fakePostgres) (*Service, string) {
	t.Helper()
	st, err := store.Open(t.TempDir()+"/config.db", "test-master")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	svc := NewService(st, &fakeFactory{k: &fakeKafka{}})
	ctx := context.Background()
	c := &model.Connection{
		ID:   "conn-pg",
		Name: "pg-local",
		Type: model.ConnectionTypePostgres,
		Config: model.MustConfigJSON(model.PostgresConfig{
			Host: "127.0.0.1", Database: "app", Username: "u",
		}),
	}
	if _, err := svc.CreateConnection(ctx, c); err != nil {
		t.Fatalf("create postgres connection: %v", err)
	}
	if err := svc.pool.Put(c.ID, fake); err != nil {
		t.Fatalf("pool put fake: %v", err)
	}
	return svc, c.ID
}

func TestServicePostgresDelegates(t *testing.T) {
	page := model.PostgresPageRowsResult{
		Columns:    []model.PostgresColumn{{Name: "id", IsInPrimaryKey: true}},
		Rows:       [][]*string{{strP("1"), nil}},
		TotalRows:  3,
		PrimaryKey: []string{"id"},
	}
	stmts := []model.PostgresStatementResult{{Statement: "SELECT 1", HasRows: true}}
	fake := &fakePostgres{
		dbs: []string{"app", "analytics"}, schemas: []string{"public", "billing"},
		tables: []model.PostgresTableInfo{{Relation: "users", Schema: "public", RelationType: string(model.PostgresRelationKindTable), RawRelationType: "r", RelationKind: model.PostgresRelationKindTable}},
		page:   page, execResult: stmts,
	}
	svc, id := newTestServiceWithPostgres(t, fake)
	ctx := context.Background()

	dbs, err := svc.PostgresDatabases(ctx, id)
	if err != nil || len(dbs) != 2 || dbs[1] != "analytics" {
		t.Fatalf("databases: %v %+v", err, dbs)
	}
	schemas, err := svc.PostgresSchemas(ctx, id, "app")
	if err != nil || len(schemas) != 2 || schemas[1] != "billing" {
		t.Fatalf("schemas: %v %+v", err, schemas)
	}
	tables, err := svc.PostgresTables(ctx, id, "app", "public")
	if err != nil || len(tables) != 1 || tables[0].Relation != "users" || tables[0].Schema != "public" {
		t.Fatalf("tables: %v %+v", err, tables)
	}
	if tables[0].RelationType != string(model.PostgresRelationKindTable) || tables[0].RelationKind != model.PostgresRelationKindTable || tables[0].RawRelationType != "r" {
		t.Fatalf("relation type contract mismatch: %+v", tables[0])
	}
	gotPage, err := svc.PostgresPageRows(ctx, id, "app", "public", "users", "table", "active", "id", true, 10, 20)
	if err != nil || gotPage.TotalRows != 3 || len(gotPage.PrimaryKey) != 1 {
		t.Fatalf("page: %v %+v", err, gotPage)
	}
	if got, want := fake.pageCall, "app.public.users:table:active:id"; got != want {
		t.Fatalf("page call = %q, want %q", got, want)
	}
	gotStmts, err := svc.PostgresExecute(ctx, id, "app", "billing", "SELECT 1", 0, 0)
	if err != nil || len(gotStmts) != 1 || !gotStmts[0].HasRows || gotStmts[0].Statement != "SELECT 1" {
		t.Fatalf("execute: %v %+v", err, gotStmts)
	}
	if fake.execSQL != "app|billing|SELECT 1" {
		t.Fatalf("execute call = %q", fake.execSQL)
	}
	if err := svc.PostgresTruncateTable(ctx, id, "app", "public", "users", "table"); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if fake.truncated != "app.public.users:table" {
		t.Fatalf("truncate call = %q", fake.truncated)
	}

	req := model.PostgresCellUpdateRequest{ConnectionID: id, Database: "app", Schema: "public", Relation: "users", RelationKind: model.PostgresRelationKindTable, Set: model.PostgresCellValue{Column: "note", Value: strP("x")}}
	preview, err := svc.PostgresPreviewCellUpdate(ctx, req)
	if err != nil || preview.MatchedRows != 0 || fake.previewCall == nil || fake.previewCall.Schema != "public" {
		t.Fatalf("preview: %v %+v", err, preview)
	}
	fake.updateErr = errors.New("boom")
	if err := svc.PostgresUpdateCell(ctx, req); err == nil || fake.updateCall == nil {
		t.Fatalf("update error/call: %v %+v", err, fake.updateCall)
	}
}

type fakePGCommand struct {
	SQL  string
	Args []any
}

type recordingPGConn struct {
	mu       sync.Mutex
	commands []fakePGCommand
	// rowsFor 非空时按 SQL 定制行集(分页测试需要给页查询与 COUNT 查询
	// 不同的应答);nil 时走 staticPGRows 默认行集。
	rowsFor func(query string) (driver.Rows, error)
}

func (c *recordingPGConn) record(sql string, args []driver.NamedValue) {
	values := make([]any, 0, len(args))
	for _, arg := range args {
		values = append(values, arg.Value)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.commands = append(c.commands, fakePGCommand{SQL: sql, Args: values})
}

func (c *recordingPGConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not used by the fake")
}
func (c *recordingPGConn) Close() error { return nil }
func (c *recordingPGConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not used by the fake")
}
func (c *recordingPGConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.record(query, args)
	return driver.RowsAffected(1), nil
}
func (c *recordingPGConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.record(query, args)
	if c.rowsFor != nil {
		return c.rowsFor(query)
	}
	return &staticPGRows{columns: []string{"?column?"}, rows: [][]driver.Value{{int64(1)}}}, nil
}

type staticPGRows struct {
	columns []string
	rows    [][]driver.Value
	cursor  int
}

func (r *staticPGRows) Columns() []string { return r.columns }
func (r *staticPGRows) Close() error      { return nil }
func (r *staticPGRows) Next(dest []driver.Value) error {
	if r.cursor >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.cursor])
	r.cursor++
	return nil
}

type recordingPGConnector struct{ conn *recordingPGConn }

func (c recordingPGConnector) Connect(context.Context) (driver.Conn, error) { return c.conn, nil }
func (c recordingPGConnector) Driver() driver.Driver                        { return fakePGDriver{} }

type fakePGDriver struct{}

func (fakePGDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("open is not supported")
}

func TestPostgresExecuteResetsSearchPathBetweenRuns(t *testing.T) {
	conn := &recordingPGConn{}
	client := &PostgresClient{
		cfg:       model.PostgresConfig{Database: "app"},
		defaultDB: "app",
		dbs:       map[string]*sql.DB{"app": sql.OpenDB(recordingPGConnector{conn})},
	}
	ctx := context.Background()
	if _, err := client.Execute(ctx, "app", "billing", "SELECT 1", 0, 0); err != nil {
		t.Fatalf("first execute: %v", err)
	}
	if _, err := client.Execute(ctx, "app", "", "SELECT 1", 0, 0); err != nil {
		t.Fatalf("second execute: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("close client: %v", err)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if len(conn.commands) != 4 {
		t.Fatalf("commands = %#v, want 4", conn.commands)
	}
	want := []fakePGCommand{
		{SQL: "SELECT set_config('search_path', $1, false)", Args: []any{"billing"}},
		{SQL: "SELECT 1", Args: []any{}},
		{SQL: "RESET search_path", Args: []any{}},
		{SQL: "SELECT 1", Args: []any{}},
	}
	for i, cmd := range want {
		got := conn.commands[i]
		if got.SQL != cmd.SQL || !reflect.DeepEqual(got.Args, cmd.Args) {
			t.Fatalf("command #%d = %#v, want %#v", i+1, got, cmd)
		}
	}
}

func TestPostgresConnPoolSettings(t *testing.T) {
	if postgresConnMaxLifetime != 30*time.Minute {
		t.Fatalf("postgresConnMaxLifetime = %v, want 30m", postgresConnMaxLifetime)
	}
	conn := &recordingPGConn{}
	db := sql.OpenDB(recordingPGConnector{conn})
	applyPostgresConnPoolSettings(db)
	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}
}

// --- Execute:服务端分页(包装查询 + COUNT 计数 / EXPLAIN 类截断回退) ---

func newPagedPGClient(t *testing.T, conn *recordingPGConn) *PostgresClient {
	t.Helper()
	return &PostgresClient{
		cfg:       model.PostgresConfig{Database: "app"},
		defaultDB: "app",
		dbs:       map[string]*sql.DB{"app": sql.OpenDB(recordingPGConnector{conn})},
	}
}

// TestPostgresExecutePagedWrapsSelect 锁定包装分页契约:SELECT 语句被改写为
// `SELECT * FROM (<原文>) _pgc LIMIT n OFFSET m` 取页,同一连接再跑
// `SELECT COUNT(*) FROM (<原文>) _pgc` 计数,res.Statement 保持用户原文。
func TestPostgresExecutePagedWrapsSelect(t *testing.T) {
	conn := &recordingPGConn{rowsFor: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "COUNT(*)") {
			return &staticPGRows{columns: []string{"count"}, rows: [][]driver.Value{{int64(1234)}}}, nil
		}
		return &staticPGRows{columns: []string{"id"}, rows: [][]driver.Value{{int64(1)}, {int64(2)}}}, nil
	}}
	client := newPagedPGClient(t, conn)
	res, err := client.Execute(context.Background(), "app", "public", "SELECT * FROM users", 10, 5)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	r := res[0]
	if r.Error != "" {
		t.Fatalf("statement must succeed, got %q", r.Error)
	}
	if r.Statement != "SELECT * FROM users" {
		t.Fatalf("res.Statement must keep the original text, got %q", r.Statement)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if len(conn.commands) < 3 {
		t.Fatalf("expected page+count after set_config, got %#v", conn.commands)
	}
	if got := conn.commands[1].SQL; got != "SELECT * FROM (SELECT * FROM users) _pgc LIMIT 10 OFFSET 5" {
		t.Fatalf("page query mismatch, got %q", got)
	}
	if got := conn.commands[2].SQL; got != "SELECT COUNT(*) FROM (SELECT * FROM users) _pgc" {
		t.Fatalf("count query mismatch, got %q", got)
	}
	if r.TotalRows == nil || *r.TotalRows != 1234 {
		t.Fatalf("total_rows must be the exact count 1234, got %+v", r.TotalRows)
	}
	if len(r.Rows) != 2 || r.Rows[0][0] == nil || *r.Rows[0][0] != "1" {
		t.Fatalf("unexpected rows: %+v", r.Rows)
	}
}

// EXPLAIN 等不能包装的语句只消费 offset+limit 行:取满 limit 行 total_rows=-1,
// 耗尽时 total_rows=offset+本页行数。
func TestPostgresExecutePagedExplainTruncates(t *testing.T) {
	conn := &recordingPGConn{rowsFor: func(string) (driver.Rows, error) {
		return &staticPGRows{columns: []string{"QUERY PLAN"}, rows: [][]driver.Value{
			{"Seq Scan on users (cost=0..1 rows=2 width=4)"},
			{"Planning Time: 0.1 ms"},
		}}, nil
	}}
	client := newPagedPGClient(t, conn)

	// 取满 limit=1 行(offset=1,消费至 2 行,本页 1 行)→ -1。
	res, err := client.Execute(context.Background(), "app", "", "EXPLAIN SELECT * FROM users", 1, 1)
	if err != nil || res[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, res)
	}
	if len(res[0].Rows) != 1 || *res[0].Rows[0][0] != "Planning Time: 0.1 ms" {
		t.Fatalf("page must start at offset 1, got %+v", res[0].Rows)
	}
	if res[0].TotalRows == nil || *res[0].TotalRows != -1 {
		t.Fatalf("a full page must report total_rows -1, got %+v", res[0].TotalRows)
	}

	// 耗尽(limit=5, offset=1,仅剩 1 行)→ offset+pageLen=2。
	res, err = client.Execute(context.Background(), "app", "", "EXPLAIN SELECT * FROM users", 5, 1)
	if err != nil || res[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, res)
	}
	if res[0].TotalRows == nil || *res[0].TotalRows != 2 {
		t.Fatalf("exhausted result must report offset+pageLen=2, got %+v", res[0].TotalRows)
	}
}

// limit=0 保持旧行为:原语句执行、无 COUNT 查询、不下发 total_rows。
func TestPostgresExecuteWithoutLimitKeepsLegacyBehavior(t *testing.T) {
	conn := &recordingPGConn{}
	client := newPagedPGClient(t, conn)
	res, err := client.Execute(context.Background(), "app", "", "SELECT 1", 0, 0)
	if err != nil || res[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, res)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	for _, cmd := range conn.commands {
		if strings.Contains(cmd.SQL, "COUNT(*)") || strings.Contains(cmd.SQL, "_pgc") {
			t.Fatalf("no paging statements may run without limit, got %#v", conn.commands)
		}
	}
	if res[0].TotalRows != nil {
		t.Fatalf("total_rows must stay unset without paging, got %+v", res[0].TotalRows)
	}
}

// --- Execute:单表 SELECT 结果附带来源 schema/relation/kind(删除行定位) ---

// TestPostgresExecuteFillsSourceForSingleTableSelect 锁定来源回填契约:
// 未限定 schema 按语句执行的 search_path 解析,kind 取 pg_class.relkind 的
// 语义映射(实体表 → table)。
func TestPostgresExecuteFillsSourceForSingleTableSelect(t *testing.T) {
	conn := &recordingPGConn{rowsFor: func(query string) (driver.Rows, error) {
		switch {
		case strings.Contains(query, "indisprimary"):
			return &staticPGRows{columns: []string{"coalesce"}, rows: [][]driver.Value{{`["id"]`}}}, nil
		case strings.Contains(query, "relkind"):
			return &staticPGRows{columns: []string{"relkind"}, rows: [][]driver.Value{{"r"}}}, nil
		}
		return &staticPGRows{columns: []string{"id"}, rows: [][]driver.Value{{int64(7)}}}, nil
	}}
	client := newPagedPGClient(t, conn)
	res, err := client.Execute(context.Background(), "app", "public", "SELECT * FROM users", 0, 0)
	if err != nil || res[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, res)
	}
	r := res[0]
	if r.SourceSchema != "public" || r.SourceRelation != "users" {
		t.Fatalf("source must resolve to (public, users), got (%q, %q)", r.SourceSchema, r.SourceRelation)
	}
	if r.SourceKind != model.PostgresRelationKindTable {
		t.Fatalf("ordinary table must report kind table, got %q", r.SourceKind)
	}
}

// TestPostgresExecuteSourceGating 锁定不下发/部分下发的边界:非单表(JOIN)
// 无来源;视图回填 kind=view 供前端禁删;relkind 查询失败时 schema/relation
// 保留、kind 留空(前端禁删)。
func TestPostgresExecuteSourceGating(t *testing.T) {
	conn := &recordingPGConn{rowsFor: func(query string) (driver.Rows, error) {
		switch {
		case strings.Contains(query, "indisprimary"):
			return &staticPGRows{columns: []string{"coalesce"}, rows: [][]driver.Value{{`["id"]`}}}, nil
		case strings.Contains(query, "relkind"):
			return &staticPGRows{columns: []string{"relkind"}, rows: [][]driver.Value{{"v"}}}, nil
		}
		return &staticPGRows{columns: []string{"id"}, rows: [][]driver.Value{{int64(1)}}}, nil
	}}
	client := newPagedPGClient(t, conn)
	res, err := client.Execute(context.Background(), "app", "public",
		"SELECT * FROM a JOIN b ON a.id = b.id; SELECT * FROM v_items", 0, 0)
	if err != nil || res[0].Error != "" || res[1].Error != "" {
		t.Fatalf("Execute: %v %+v", err, res)
	}
	if res[0].SourceSchema != "" || res[0].SourceRelation != "" || res[0].SourceKind != "" {
		t.Fatalf("join must not carry source, got (%q, %q, %q)",
			res[0].SourceSchema, res[0].SourceRelation, res[0].SourceKind)
	}
	if res[1].SourceSchema != "public" || res[1].SourceRelation != "v_items" {
		t.Fatalf("view select must carry source, got (%q, %q)",
			res[1].SourceSchema, res[1].SourceRelation)
	}
	if res[1].SourceKind != model.PostgresRelationKindView {
		t.Fatalf("view must report kind view, got %q", res[1].SourceKind)
	}

	// relkind 查询失败:kind 留空,schema/relation 不受影响,语句不报错。
	failConn := &recordingPGConn{rowsFor: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "relkind") {
			return nil, errors.New("pg_class unavailable")
		}
		return &staticPGRows{columns: []string{"id"}, rows: [][]driver.Value{{int64(1)}}}, nil
	}}
	failClient := newPagedPGClient(t, failConn)
	res, err = failClient.Execute(context.Background(), "app", "public", "SELECT * FROM users", 0, 0)
	if err != nil || res[0].Error != "" {
		t.Fatalf("kind lookup failure must not fail the statement: %v %+v", err, res)
	}
	if res[0].SourceSchema != "public" || res[0].SourceRelation != "users" || res[0].SourceKind != "" {
		t.Fatalf("kind failure must keep source names and leave kind empty, got (%q, %q, %q)",
			res[0].SourceSchema, res[0].SourceRelation, res[0].SourceKind)
	}
}

// --- P0-1:数据修改 CTE 禁用包装与计数 ---

// postgresStatementContainsDML:顶层(深度 0)与 WITH 之后第一层 CTE 子查询
// (深度 1)中出现 INSERT/UPDATE/DELETE/MERGE 才命中;字符串、双引号标识符、
// 美元体与更深层子查询里的同形词一律不算。
func TestPostgresStatementContainsDML(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"delete cte", "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", true},
		{"update cte", "WITH d AS (UPDATE t SET x = 1 RETURNING *) SELECT * FROM d", true},
		{"insert cte", "WITH d AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM d", true},
		{"second cte carries dml", "WITH a AS (SELECT 1), d AS (DELETE FROM t RETURNING *) SELECT * FROM a, d", true},
		{"top level delete after cte", "WITH a AS (SELECT 1) DELETE FROM t", true},
		{"lowercase keyword", "with d as (delete from t returning *) select * from d", true},
		{"plain select cte", "WITH a AS (SELECT 1) SELECT * FROM a", false},
		{"keyword only in string", "WITH a AS (SELECT 'DELETE FROM t' AS q) SELECT * FROM a", false},
		{"keyword only in dollar body", "WITH a AS (SELECT $$DELETE FROM t$$ AS q) SELECT * FROM a", false},
		{"keyword only in quoted ident", `WITH a AS (SELECT "delete" FROM t) SELECT * FROM a`, false},
		{"keyword only in comment", "WITH a AS (SELECT /* DELETE */ 1) SELECT * FROM a", false},
		{"word boundary prefix", "WITH a AS (SELECT deleted_at FROM t) SELECT * FROM a", false},
	}
	for _, tc := range cases {
		if got := postgresStatementContainsDML(tc.in); got != tc.want {
			t.Fatalf("%s: postgresStatementContainsDML(%q) = %v, want %v", tc.name, tc.in, got, tc.want)
		}
	}
}

// P0-1 集成:数据修改 CTE 不得包装分页——包装执行一次、COUNT 再执行一次会
// 让 DELETE 生效两次。命中检测时与 EXPLAIN/SHOW 同走客户端截断回退:原语句
// 只执行一次,无任何 _pgc 包装/COUNT 语句,total_rows 走截断语义。
func TestPostgresExecutePagedDMLCteRunsOnceWithoutWrapOrCount(t *testing.T) {
	conn := &recordingPGConn{rowsFor: func(string) (driver.Rows, error) {
		return &staticPGRows{columns: []string{"id"}, rows: [][]driver.Value{{int64(1)}, {int64(2)}, {int64(3)}}}, nil
	}}
	client := newPagedPGClient(t, conn)
	res, err := client.Execute(context.Background(), "app", "",
		"WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", 2, 0)
	if err != nil || res[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, res)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	// set_config + 原语句,恰好两条:无包装页查询、无 COUNT 第二次执行。
	if len(conn.commands) != 2 {
		t.Fatalf("dml cte must run verbatim exactly once, got %#v", conn.commands)
	}
	if got := conn.commands[1].SQL; got != "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d" {
		t.Fatalf("statement must not be wrapped, got %q", got)
	}
	if len(res[0].Rows) != 2 {
		t.Fatalf("page must hold limit rows, got %+v", res[0].Rows)
	}
	if res[0].TotalRows == nil || *res[0].TotalRows != -1 {
		t.Fatalf("a full page must report total_rows -1, got %+v", res[0].TotalRows)
	}
}

// --- P1-2:分页包装丢失 ORDER BY ---

// splitTrailingTopLevelOrderBy:只外提语句顶层(括号深度 0,引号/注释/美元
// 体之外)、其后没有 LIMIT/OFFSET/FOR 等尾巴的结尾 ORDER BY。
func TestSplitTrailingTopLevelOrderBy(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		head  string
		order string
		ok    bool
	}{
		{"trailing order by", "SELECT * FROM users ORDER BY created_at DESC", "SELECT * FROM users", "ORDER BY created_at DESC", true},
		{"expression kept verbatim", "SELECT a FROM t ORDER BY lower(name) DESC, id NULLS LAST", "SELECT a FROM t", "ORDER BY lower(name) DESC, id NULLS LAST", true},
		{"paren wrapped query", "(SELECT * FROM a UNION SELECT * FROM b) ORDER BY id", "(SELECT * FROM a UNION SELECT * FROM b)", "ORDER BY id", true},
		{"cte body order by stays inside", "WITH c AS (SELECT * FROM t ORDER BY id) SELECT * FROM c", "", "", false},
		{"trailing order by after cte", "WITH c AS (SELECT * FROM t) SELECT * FROM c ORDER BY name", "WITH c AS (SELECT * FROM t) SELECT * FROM c", "ORDER BY name", true},
		{"limit tail blocks hoist", "SELECT * FROM t ORDER BY id LIMIT 10", "", "", false},
		{"offset tail blocks hoist", "SELECT * FROM t ORDER BY id OFFSET 5", "", "", false},
		{"for update tail blocks hoist", "SELECT * FROM t ORDER BY id FOR UPDATE", "", "", false},
		{"subquery order by not top level", "SELECT * FROM (SELECT * FROM t ORDER BY id) s", "", "", false},
		{"string literal skipped", "SELECT 'ORDER BY x' FROM t ORDER BY id", "SELECT 'ORDER BY x' FROM t", "ORDER BY id", true},
		{"quoted identifier skipped", `SELECT "ORDER BY" FROM t ORDER BY id`, `SELECT "ORDER BY" FROM t`, "ORDER BY id", true},
		{"no order by", "SELECT * FROM t", "", "", false},
		{"lowercase keywords", "select * from t order by id", "select * from t", "order by id", true},
		{"unbalanced parens bail out", "SELECT * FROM (t ORDER BY id", "", "", false},
	}
	for _, tc := range cases {
		head, order, ok := splitTrailingTopLevelOrderBy(tc.in)
		if ok != tc.ok || head != tc.head || order != tc.order {
			t.Fatalf("%s: splitTrailingTopLevelOrderBy(%q) = (%q, %q, %v), want (%q, %q, %v)",
				tc.name, tc.in, head, order, ok, tc.head, tc.order, tc.ok)
		}
	}
}

// P1-2 集成:带顶层尾 ORDER BY 的 SELECT,页查询把 ORDER BY 外提到包装
// 外层(派生表不保证保留子查询内 ORDER BY);COUNT 仍包装原文,不带外提。
func TestPostgresExecutePagedHoistsTrailingOrderBy(t *testing.T) {
	conn := &recordingPGConn{rowsFor: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "COUNT(*)") {
			return &staticPGRows{columns: []string{"count"}, rows: [][]driver.Value{{int64(7)}}}, nil
		}
		return &staticPGRows{columns: []string{"id"}, rows: [][]driver.Value{{int64(1)}}}, nil
	}}
	client := newPagedPGClient(t, conn)
	res, err := client.Execute(context.Background(), "app", "", "SELECT * FROM users ORDER BY created_at DESC", 10, 5)
	if err != nil || res[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, res)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if len(conn.commands) < 3 {
		t.Fatalf("expected page+count after set_config, got %#v", conn.commands)
	}
	wantPage := "SELECT * FROM (SELECT * FROM users) _pgc ORDER BY created_at DESC LIMIT 10 OFFSET 5"
	wantCount := "SELECT COUNT(*) FROM (SELECT * FROM users ORDER BY created_at DESC) _pgc"
	if got := conn.commands[1].SQL; got != wantPage {
		t.Fatalf("page query mismatch, got %q want %q", got, wantPage)
	}
	if got := conn.commands[2].SQL; got != wantCount {
		t.Fatalf("count query mismatch, got %q want %q", got, wantCount)
	}
}

// --- P2-2:负数分页参数钳制 ---

func TestPostgresExecuteClampsNegativePaging(t *testing.T) {
	conn := &recordingPGConn{}
	client := newPagedPGClient(t, conn)
	res, err := client.Execute(context.Background(), "app", "", "SELECT 1", -1, -5)
	if err != nil || res[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, res)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	for _, cmd := range conn.commands {
		if strings.Contains(cmd.SQL, "_pgc") || strings.Contains(cmd.SQL, "COUNT(*)") {
			t.Fatalf("negative limit must disable paging, got %#v", conn.commands)
		}
	}
	if res[0].TotalRows != nil {
		t.Fatalf("total_rows must stay unset without paging, got %+v", res[0].TotalRows)
	}
}
