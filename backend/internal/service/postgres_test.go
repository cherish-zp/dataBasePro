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

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/store"
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
func (f *fakePostgres) Execute(_ context.Context, database, schema, sqlText string) ([]model.PostgresStatementResult, error) {
	f.execSQL = database + "|" + schema + "|" + sqlText
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
	gotStmts, err := svc.PostgresExecute(ctx, id, "app", "billing", "SELECT 1")
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
	if _, err := client.Execute(ctx, "app", "billing", "SELECT 1"); err != nil {
		t.Fatalf("first execute: %v", err)
	}
	if _, err := client.Execute(ctx, "app", "", "SELECT 1"); err != nil {
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
