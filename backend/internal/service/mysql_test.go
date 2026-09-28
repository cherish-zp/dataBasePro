package service

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"

	"dataBasePro/backend/internal/model"
)

func strPtrOf(s string) *string { return &s }

// --- 纯函数:DSN 构造 ---

func TestBuildMysqlDSN_Basics(t *testing.T) {
	dsn, err := buildMysqlDSN(model.MysqlConfig{Host: "127.0.0.1", Port: 4000, Username: "root", Password: "pw", Database: "app"})
	if err != nil {
		t.Fatalf("buildMysqlDSN: %v", err)
	}
	for _, want := range []string{
		"root:pw@tcp(127.0.0.1:4000)/app",
		"charset=utf8mb4",
		"parseTime=true",
		"loc=Local",
	} {
		if !strings.Contains(dsn, want) {
			t.Fatalf("dsn must contain %q, got %s", want, dsn)
		}
	}
	if strings.Contains(dsn, "tls=") {
		t.Fatalf("disabled tls_mode must not append a tls param, got %s", dsn)
	}
}

func TestBuildMysqlDSN_DefaultPort(t *testing.T) {
	dsn, err := buildMysqlDSN(model.MysqlConfig{Host: "h"})
	if err != nil {
		t.Fatalf("buildMysqlDSN: %v", err)
	}
	if !strings.Contains(dsn, "tcp(h:3306)") {
		t.Fatalf("port 0 must default to 3306, got %s", dsn)
	}
}

func TestBuildMysqlDSN_TLSModes(t *testing.T) {
	dsn, err := buildMysqlDSN(model.MysqlConfig{Host: "h", TLSMode: model.MysqlTLSSkipVerify})
	if err != nil {
		t.Fatalf("buildMysqlDSN: %v", err)
	}
	if !strings.Contains(dsn, "tls=skip-verify") {
		t.Fatalf("skip-verify must map to tls=skip-verify, got %s", dsn)
	}

	dsn, err = buildMysqlDSN(model.MysqlConfig{Host: "h", TLSMode: model.MysqlTLSVerifyFull})
	if err != nil {
		t.Fatalf("buildMysqlDSN: %v", err)
	}
	want := "tls=" + mysqlTLSConfigName("h")
	if !strings.Contains(dsn, want) {
		t.Fatalf("verify-full must register a custom tls name, want %q in %s", want, dsn)
	}
	// 同一 host 重复注册必须幂等(不报错、名字稳定)。
	dsn2, err := buildMysqlDSN(model.MysqlConfig{Host: "h", TLSMode: model.MysqlTLSVerifyFull})
	if err != nil || dsn2 != dsn {
		t.Fatalf("verify-full registration must be idempotent: %v %s vs %s", err, dsn2, dsn)
	}
}

func TestBuildMysqlDSN_EscapesCredentials(t *testing.T) {
	dsn, err := buildMysqlDSN(model.MysqlConfig{Host: "h", Username: "u@ser", Password: "p@ss'w/rd"})
	if err != nil {
		t.Fatalf("buildMysqlDSN: %v", err)
	}
	// DSN 必须能被驱动解析回去,凭据不破坏结构。
	parsed, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatalf("ParseDSN: %v (dsn %s)", err, dsn)
	}
	if parsed.User != "u@ser" || parsed.Passwd != "p@ss'w/rd" {
		t.Fatalf("credentials must round-trip: user=%q passwd=%q", parsed.User, parsed.Passwd)
	}
}

func TestBuildMysqlDSN_RejectsInvalidConfig(t *testing.T) {
	if _, err := buildMysqlDSN(model.MysqlConfig{}); err == nil {
		t.Fatal("empty host must be rejected before dialing")
	}
}

// --- 纯函数:单元格更新的展示文本与参数化语句 ---

func TestBuildMysqlCellUpdateStatement_DisplayText(t *testing.T) {
	set := model.MysqlCellValue{Column: "note", Value: strPtrOf("it's")}
	where := []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}}
	stmt, err := buildMysqlCellUpdateStatement("app", "users", set, where)
	if err != nil {
		t.Fatalf("buildMysqlCellUpdateStatement: %v", err)
	}
	want := "UPDATE `app`.`users` SET `note` = 'it''s' WHERE `id` = '1'"
	if stmt != want {
		t.Fatalf("unexpected statement:\n got %s\nwant %s", stmt, want)
	}

	// nil 值渲染为 NULL。
	stmt, err = buildMysqlCellUpdateStatement("app", "users", model.MysqlCellValue{Column: "note"}, where)
	if err != nil {
		t.Fatalf("buildMysqlCellUpdateStatement: %v", err)
	}
	if !strings.Contains(stmt, "SET `note` = NULL") {
		t.Fatalf("nil value must render as NULL, got %s", stmt)
	}
}

func TestBuildMysqlCellUpdateStatement_Validation(t *testing.T) {
	where := []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}}
	if _, err := buildMysqlCellUpdateStatement("app", " ", model.MysqlCellValue{Column: "a"}, where); err == nil {
		t.Fatal("empty table must be rejected")
	}
	if _, err := buildMysqlCellUpdateStatement("app", "t", model.MysqlCellValue{Column: " "}, where); err == nil {
		t.Fatal("empty set column must be rejected")
	}
	if _, err := buildMysqlCellUpdateStatement("app", "t", model.MysqlCellValue{Column: "a"}, nil); err == nil {
		t.Fatal("empty where must be rejected")
	}
	if _, err := buildMysqlCellUpdateStatement("app", "t", model.MysqlCellValue{Column: "a"},
		[]model.MysqlCellValue{{Column: " ", Value: strPtrOf("1")}}); err == nil {
		t.Fatal("empty where column must be rejected")
	}
}

func TestBuildMysqlUpdateExec_Parameterized(t *testing.T) {
	set := model.MysqlCellValue{Column: "note", Value: strPtrOf("x")}
	where := []model.MysqlCellValue{
		{Column: "id", Value: strPtrOf("1")},
		{Column: "tenant", Value: strPtrOf("a")},
	}
	query, args, err := buildMysqlUpdateExec("app", "users", set, where)
	if err != nil {
		t.Fatalf("buildMysqlUpdateExec: %v", err)
	}
	want := "UPDATE `app`.`users` SET `note` = ? WHERE `id` = ? AND `tenant` = ?"
	if query != want {
		t.Fatalf("unexpected query:\n got %s\nwant %s", query, want)
	}
	if len(args) != 3 || args[0].(string) != "x" || args[1].(string) != "1" || args[2].(string) != "a" {
		t.Fatalf("unexpected args: %+v", args)
	}
}

func TestBuildMysqlUpdateExec_NilValueIsNULLArg(t *testing.T) {
	// SET 值 nil → 参数 nil(驱动发送 SQL NULL);WHERE 值 nil → IS NULL 且不带参数。
	set := model.MysqlCellValue{Column: "note"}
	where := []model.MysqlCellValue{{Column: "id"}, {Column: "k", Value: strPtrOf("a")}}
	query, args, err := buildMysqlUpdateExec("app", "t", set, where)
	if err != nil {
		t.Fatalf("buildMysqlUpdateExec: %v", err)
	}
	want := "UPDATE `app`.`t` SET `note` = ? WHERE `id` IS NULL AND `k` = ?"
	if query != want {
		t.Fatalf("unexpected query:\n got %s\nwant %s", query, want)
	}
	if len(args) != 2 || args[0] != nil || args[1].(string) != "a" {
		t.Fatalf("unexpected args: %+v", args)
	}
}

func TestBuildMysqlCountQuery(t *testing.T) {
	where := []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}}
	query, args, err := buildMysqlCountQuery("app", "users", where)
	if err != nil {
		t.Fatalf("buildMysqlCountQuery: %v", err)
	}
	if query != "SELECT COUNT(*) FROM `app`.`users` WHERE `id` = ?" {
		t.Fatalf("unexpected count query: %s", query)
	}
	if len(args) != 1 || args[0].(string) != "1" {
		t.Fatalf("unexpected args: %+v", args)
	}
	if _, _, err := buildMysqlCountQuery("app", "users", nil); err == nil {
		t.Fatal("empty where must be rejected for count")
	}
}

// --- 纯函数:主键校验(表无主键/where 仅允许主键列) ---

func TestRequireMysqlPrimaryKey(t *testing.T) {
	if err := requireMysqlPrimaryKey(nil); err == nil || !strings.Contains(err.Error(), "表无主键") {
		t.Fatalf("no primary key must error with 表无主键, got %v", err)
	}
	if err := requireMysqlPrimaryKey([]string{"id"}); err != nil {
		t.Fatalf("primary key present must pass: %v", err)
	}
}

func TestValidateMysqlEditWhere(t *testing.T) {
	if err := validateMysqlEditWhere(nil, []string{"id"}); err == nil {
		t.Fatal("empty where must be rejected")
	}
	err := validateMysqlEditWhere([]model.MysqlCellValue{{Column: "name", Value: strPtrOf("x")}}, []string{"id"})
	if err == nil || !strings.Contains(err.Error(), "主键") {
		t.Fatalf("non-primary-key where column must be rejected, got %v", err)
	}
	if err := validateMysqlEditWhere([]model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}}, []string{"id", "tenant"}); err != nil {
		t.Fatalf("primary-key where must pass: %v", err)
	}
}

// --- 纯函数:系统库过滤 ---

func TestIsMysqlSystemDatabase(t *testing.T) {
	for _, name := range []string{"information_schema", "mysql", "performance_schema", "sys"} {
		if !isMysqlSystemDatabase(name) {
			t.Fatalf("%q must be recognized as a system database", name)
		}
		if !isMysqlSystemDatabase(strings.ToUpper(name)) {
			t.Fatalf("system database match must be case-insensitive: %q", name)
		}
	}
	for _, name := range []string{"app", "app_sys", "mysqlx", "syslog"} {
		if isMysqlSystemDatabase(name) {
			t.Fatalf("%q must not be treated as a system database", name)
		}
	}
}

func TestMysqlDatabasesQuery(t *testing.T) {
	query := mysqlDatabasesQuery()
	if !strings.Contains(query, "information_schema.schemata") || !strings.Contains(query, "ORDER BY schema_name") {
		t.Fatalf("unexpected databases query: %s", query)
	}
	if got := strings.Count(query, "?"); got != 4 {
		t.Fatalf("databases query must exclude exactly the 4 system schemas, got %d placeholders: %s", got, query)
	}
}

// --- 纯函数:语句是否走查询(返回结果集) ---

func TestMysqlStatementReturnsRows(t *testing.T) {
	for _, stmt := range []string{"SELECT 1", "show tables", "DESC t", "DESCRIBE t", "EXPLAIN SELECT 1", "WITH c AS (SELECT 1) SELECT * FROM c"} {
		if !mysqlStatementReturnsRows(stmt) {
			t.Fatalf("%q must be treated as a rows-returning statement", stmt)
		}
	}
	for _, stmt := range []string{"INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t", "CREATE TABLE t (id int)", "TRUNCATE TABLE t", "SET @x = 1"} {
		if mysqlStatementReturnsRows(stmt) {
			t.Fatalf("%q must not be treated as a rows-returning statement", stmt)
		}
	}
}

// --- 客户端类型元数据 ---

func TestMysqlClientTypeMetadata(t *testing.T) {
	c := &MysqlClient{connType: model.ConnectionTypeTiDB}
	if c.GetType() != "tidb" {
		t.Fatalf("GetType must return the real connection type, got %q", c.GetType())
	}
	if c.GetName() != "mysql" {
		t.Fatalf("unexpected name %q", c.GetName())
	}
	c2 := &MysqlClient{connType: model.ConnectionTypeMySQL}
	if c2.GetType() != "mysql" {
		t.Fatalf("GetType must return mysql, got %q", c2.GetType())
	}
}

func TestNewMysqlClientOfType_RejectsForeignType(t *testing.T) {
	if _, err := NewMysqlClientOfType(model.MysqlConfig{Host: "h"}, model.ConnectionTypeKafka); err == nil {
		t.Fatal("non-mysql/tidb connection type must be rejected")
	}
}

// --- Service 层类型分发 ---

// fakeMysqlDS implements MysqlDataSource for service-layer dispatch tests.
type fakeMysqlDS struct {
	fakeDataSource
	dbs          []string
	tables       []model.MysqlTableInfo
	page         model.MysqlPageRowsResult
	pageTarget   string
	truncated    string
	execDB       string
	execSQL      string
	execLimit    int
	execOffset   int
	execResult   []model.MysqlStatementResult
	previewOut   model.MysqlCellUpdatePreview
	previewErr   error
	updateErr    error
	previewArgs  mysqlCellUpdateArgs
	updateArgs   mysqlCellUpdateArgs
	hitDatabases bool
}

type mysqlCellUpdateArgs struct {
	database, table string
	set             model.MysqlCellValue
	where           []model.MysqlCellValue
}

func (f *fakeMysqlDS) Databases(context.Context) ([]string, error) {
	f.hitDatabases = true
	return f.dbs, nil
}
func (f *fakeMysqlDS) Tables(_ context.Context, database string) ([]model.MysqlTableInfo, error) {
	f.pageTarget = "tables:" + database
	return f.tables, nil
}
func (f *fakeMysqlDS) PageRows(_ context.Context, database, table, _, _ string, _ bool, _, _ int) (model.MysqlPageRowsResult, error) {
	f.pageTarget = database + "." + table
	return f.page, nil
}
func (f *fakeMysqlDS) TruncateTable(_ context.Context, database, table string) error {
	f.truncated = database + "." + table
	return nil
}
func (f *fakeMysqlDS) Execute(_ context.Context, database, sqlText string, limit, offset int) ([]model.MysqlStatementResult, error) {
	f.execDB = database
	f.execSQL = sqlText
	f.execLimit, f.execOffset = limit, offset
	return f.execResult, nil
}
func (f *fakeMysqlDS) PreviewCellUpdate(_ context.Context, database, table string, set model.MysqlCellValue, where []model.MysqlCellValue) (model.MysqlCellUpdatePreview, error) {
	f.previewArgs = mysqlCellUpdateArgs{database: database, table: table, set: set, where: where}
	return f.previewOut, f.previewErr
}
func (f *fakeMysqlDS) UpdateCell(_ context.Context, database, table string, set model.MysqlCellValue, where []model.MysqlCellValue) error {
	f.updateArgs = mysqlCellUpdateArgs{database: database, table: table, set: set, where: where}
	return f.updateErr
}

var _ MysqlDataSource = (*fakeMysqlDS)(nil)

// TestMysqlAccessorDelegatesToPooledFake verifies the mysql() pool accessor:
// a pooled MysqlDataSource (poured in via PutPooledForTest) receives the calls
// without any dialing, for both the mysql and tidb connection types.
func TestMysqlAccessorDelegatesToPooledFake(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, err := svc.CreateConnection(ctx, &model.Connection{
		Name:   "tidb-local",
		Type:   model.ConnectionTypeTiDB,
		Config: model.MustConfigJSON(model.MysqlConfig{Host: "127.0.0.1", Port: 4000}),
	})
	if err != nil {
		t.Fatalf("create tidb connection: %v", err)
	}
	fake := &fakeMysqlDS{dbs: []string{"app"}}
	if err := svc.PutPooledForTest(c.ID, fake); err != nil {
		t.Fatalf("pool fake: %v", err)
	}

	dbs, err := svc.MysqlDatabases(ctx, c.ID)
	if err != nil || len(dbs) != 1 || dbs[0] != "app" {
		t.Fatalf("MysqlDatabases: %v %+v", err, dbs)
	}
	if !fake.hitDatabases {
		t.Fatal("delegation must reach the pooled fake")
	}
	if _, err := svc.MysqlExecute(ctx, c.ID, "app", "SELECT 1", 0, 0); err != nil || fake.execSQL != "SELECT 1" || fake.execDB != "app" {
		t.Fatalf("MysqlExecute: %v sql=%q db=%q", err, fake.execSQL, fake.execDB)
	}
}

// TestMysqlAccessorRejectsNonMysqlClient verifies the type guard: a pooled
// data source that does not implement MysqlDataSource must not be cast blindly.
func TestMysqlAccessorRejectsNonMysqlClient(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, sampleConn())
	if err := svc.PutPooledForTest(c.ID, &fakeDataSource{}); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	if _, err := svc.MysqlDatabases(ctx, c.ID); err == nil || !strings.Contains(err.Error(), "MySQL") {
		t.Fatalf("non-mysql pooled client must be rejected, got %v", err)
	}
}

// TestConnectConnectionDispatchesMysqlTypes verifies the ConnectConnection type
// switch: mysql/tidb connections reach the MySQL builder (invalid configs fail
// on validation, before any dialing — a kafka misroute would error differently).
func TestConnectConnectionDispatchesMysqlTypes(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	for _, typ := range []model.ConnectionType{model.ConnectionTypeMySQL, model.ConnectionTypeTiDB} {
		// 直接写 store 绕过 CreateConnection 的前置校验:让 ConnectConnection
		// 自己走到 mysql builder 的校验(空 host 在拨号前失败,kafka 误分发会
		// 报不同的错)。
		c := &model.Connection{
			ID:     "dispatch-" + string(typ),
			Name:   "local",
			Type:   typ,
			Config: model.MustConfigJSON(model.MysqlConfig{}),
		}
		if err := svc.store.CreateConnection(c); err != nil {
			t.Fatalf("store %s connection: %v", typ, err)
		}
		err := svc.ConnectConnection(ctx, c.ID)
		if err == nil {
			t.Fatalf("%s: invalid config must fail", typ)
		}
		if !strings.Contains(err.Error(), "mysql host") {
			t.Fatalf("%s must dispatch to the mysql builder, got %v", typ, err)
		}
	}
}

// TestMysqlCellUpdateServiceDelegation verifies the service layer passes the
// cell-update arguments through to the data source.
func TestMysqlCellUpdateServiceDelegation(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, &model.Connection{
		Name:   "mysql-local",
		Type:   model.ConnectionTypeMySQL,
		Config: model.MustConfigJSON(model.MysqlConfig{Host: "127.0.0.1"}),
	})
	fake := &fakeMysqlDS{}
	if err := svc.PutPooledForTest(c.ID, fake); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	set := model.MysqlCellValue{Column: "note", Value: strPtrOf("x")}
	where := []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}}

	if err := svc.MysqlUpdateCell(ctx, c.ID, "app", "users", set, where); err != nil {
		t.Fatalf("MysqlUpdateCell: %v", err)
	}
	if fake.updateArgs.database != "app" || fake.updateArgs.table != "users" || fake.updateArgs.set.Column != "note" {
		t.Fatalf("update args must pass through: %+v", fake.updateArgs)
	}

	fake.previewErr = errors.New("boom")
	if _, err := svc.MysqlPreviewCellUpdate(ctx, c.ID, "app", "users", set, where); err == nil {
		t.Fatal("preview failure must surface")
	}
}

// --- Execute:USE 构造与「按库执行」路径 ---

func TestBuildMysqlUseDatabase(t *testing.T) {
	if got := buildMysqlUseDatabase("app"); got != "USE `app`" {
		t.Fatalf("buildMysqlUseDatabase(app) = %q, want USE `app`", got)
	}
	// 标识符内部反引号必须双写转义。
	if got := buildMysqlUseDatabase("a`b"); got != "USE `a``b`" {
		t.Fatalf("embedded backtick must be doubled, got %q", got)
	}
}

// fakeMysqlDrvConn 是 driver.Conn 的最小实现:记录在其上 Exec/Query 过的
// 语句,供「USE 之后全部语句固定在同一连接」的断言使用;information_schema
// 主键查询由 pkByTable/pkErr 桩应答(不记入 queries)。
type fakeMysqlDrvConn struct {
	execs   []string
	queries []string
	useErr  error // 非空时对 USE 语句返回该错误(模拟库不存在)
	// pkByTable 按 "schema.table" 给出主键列(模拟 information_schema.columns
	// 按 ordinal_position 排好序的 PRI 行);缺键/空值即无主键。pkErr 非空时
	// 主键查询一律报错。pkArgs 记录每次主键查询的 (table_schema, table_name)。
	pkByTable map[string][]string
	pkErr     error
	pkArgs    [][]driver.Value
	// queryRows 非空时,业务查询(非 information_schema)返回该结果集,
	// 供 collectMysqlRows 的 wire 形状测试使用。
	queryRows *fakeMysqlDrvRows
	// countRows 非空时,SELECT COUNT(*) 查询返回该结果集(分页计数与页数据
	// 需要不同的应答,故与 queryRows 分开)。
	countRows *fakeMysqlDrvRows
}

// pkResultRows 把桩数据渲染成 information_schema.columns 形状的结果集
// (column_name, column_type, column_comment, column_key),PRI 行按给定
// 顺序(即 ordinal 序)逐行给出。
func (c *fakeMysqlDrvConn) pkResultRows(args []driver.Value) *fakeMysqlDrvRows {
	var pk []string
	if len(args) >= 2 {
		pk = c.pkByTable[args[0].(string)+"."+args[1].(string)]
	}
	cols := []string{"column_name", "column_type", "column_comment", "column_key"}
	var vals [][]driver.Value
	for _, name := range pk {
		vals = append(vals, []driver.Value{name, "bigint", "", "PRI"})
	}
	return &fakeMysqlDrvRows{cols: cols, vals: vals}
}

func (c *fakeMysqlDrvConn) Prepare(query string) (driver.Stmt, error) {
	return &fakeMysqlDrvStmt{conn: c, query: query}, nil
}
func (c *fakeMysqlDrvConn) Close() error { return nil }
func (c *fakeMysqlDrvConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions unsupported")
}

type fakeMysqlDrvStmt struct {
	conn  *fakeMysqlDrvConn
	query string
}

func (s *fakeMysqlDrvStmt) Close() error  { return nil }
func (s *fakeMysqlDrvStmt) NumInput() int { return -1 }
func (s *fakeMysqlDrvStmt) Exec([]driver.Value) (driver.Result, error) {
	if strings.HasPrefix(strings.ToUpper(s.query), "USE ") && s.conn.useErr != nil {
		return nil, s.conn.useErr
	}
	s.conn.execs = append(s.conn.execs, s.query)
	return driver.RowsAffected(0), nil
}
func (s *fakeMysqlDrvStmt) Query(args []driver.Value) (driver.Rows, error) {
	if strings.HasPrefix(strings.ToUpper(s.query), "USE ") && s.conn.useErr != nil {
		return nil, s.conn.useErr
	}
	// information_schema 主键查询由桩应答,不记入业务 queries。
	if strings.Contains(s.query, "information_schema.columns") {
		s.conn.pkArgs = append(s.conn.pkArgs, args)
		if s.conn.pkErr != nil {
			return nil, s.conn.pkErr
		}
		return s.conn.pkResultRows(args), nil
	}
	s.conn.queries = append(s.conn.queries, s.query)
	if s.conn.countRows != nil && strings.Contains(strings.ToUpper(s.query), "COUNT(*)") {
		return s.conn.countRows, nil
	}
	if s.conn.queryRows != nil {
		return s.conn.queryRows, nil
	}
	return &fakeMysqlDrvRows{cols: []string{"1"}}, nil
}

type fakeMysqlDrvRows struct {
	cols  []string
	types []string         // 按列给出 DatabaseTypeName(缺省空串,模拟未报告类型)
	vals  [][]driver.Value // 预置数据行(空 = 立即 EOF)
	pos   int
}

func (r *fakeMysqlDrvRows) Columns() []string { return r.cols }

// ColumnTypeDatabaseTypeName 让 database/sql 的 ColumnTypes 报告列类型名,
// 供按列类型格式化时间单元格的路径使用。
func (r *fakeMysqlDrvRows) ColumnTypeDatabaseTypeName(index int) string {
	if index < 0 || index >= len(r.types) {
		return ""
	}
	return r.types[index]
}
func (r *fakeMysqlDrvRows) Close() error { return nil }
func (r *fakeMysqlDrvRows) Next(dest []driver.Value) error {
	if r.pos >= len(r.vals) {
		return io.EOF
	}
	copy(dest, r.vals[r.pos])
	r.pos++
	return nil
}

// fakeMysqlConnector 按 database/sql Connector 契约供给 fake 连接;pending
// 非空时先复用它(可预置故障),否则新建并记录。
type fakeMysqlConnector struct {
	pending *fakeMysqlDrvConn
	created []*fakeMysqlDrvConn
}

func (c *fakeMysqlConnector) Connect(context.Context) (driver.Conn, error) {
	if c.pending != nil {
		conn := c.pending
		c.created = append(c.created, conn)
		c.pending = nil
		return conn, nil
	}
	conn := &fakeMysqlDrvConn{}
	c.created = append(c.created, conn)
	return conn, nil
}
func (c *fakeMysqlConnector) Driver() driver.Driver { return fakeMysqlDrv{} }

type fakeMysqlDrv struct{}

func (fakeMysqlDrv) Open(string) (driver.Conn, error) { return nil, errors.New("use sql.OpenDB") }

// newFakeMysqlClient 基于 in-memory fake 驱动构造 MysqlClient(绕过拨号),
// 返回记录所有物理连接的切片指针。
func newFakeMysqlClient(t *testing.T, pending *fakeMysqlDrvConn) (*MysqlClient, *[]*fakeMysqlDrvConn) {
	t.Helper()
	ctor := &fakeMysqlConnector{pending: pending}
	db := sql.OpenDB(ctor)
	t.Cleanup(func() { _ = db.Close() })
	return &MysqlClient{db: db, connType: model.ConnectionTypeMySQL}, &ctor.created
}

func TestMysqlExecuteWithDatabasePinsUSEAndStatements(t *testing.T) {
	c, created := newFakeMysqlClient(t, nil)
	results, err := c.Execute(context.Background(), "订单", "SELECT 1;\nSET @x = 1;", 0, 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(results) != 2 || results[0].SQL != "SELECT 1" || results[1].SQL != "SET @x = 1" {
		t.Fatalf("unexpected results: %+v", results)
	}
	if len(*created) != 1 {
		t.Fatalf("all statements must run on one dedicated connection, got %d: %+v", len(*created), *created)
	}
	conn := (*created)[0]
	if len(conn.execs) != 2 || conn.execs[0] != "USE `订单`" || conn.execs[1] != "SET @x = 1" {
		t.Fatalf("USE must precede exec statements on the pinned conn: %+v", conn.execs)
	}
	if len(conn.queries) != 1 || conn.queries[0] != "SELECT 1" {
		t.Fatalf("rows statement must run on the pinned conn: %+v", conn.queries)
	}
}

func TestMysqlExecuteWithoutDatabaseSkipsUSE(t *testing.T) {
	c, created := newFakeMysqlClient(t, nil)
	if _, err := c.Execute(context.Background(), "", "SELECT 1", 0, 0); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	for _, conn := range *created {
		for _, q := range append(append([]string{}, conn.execs...), conn.queries...) {
			if strings.HasPrefix(strings.ToUpper(q), "USE ") {
				t.Fatalf("empty database must not issue USE, got %q", q)
			}
		}
	}
	if len(*created) == 0 || len((*created)[0].queries) != 1 {
		t.Fatalf("statement must still run via the pool: %+v", *created)
	}
}

func TestMysqlExecuteUSEFailureStopsBeforeStatements(t *testing.T) {
	pinned := &fakeMysqlDrvConn{useErr: errors.New("Error 1049: Unknown database 'nope'")}
	c, created := newFakeMysqlClient(t, pinned)
	results, err := c.Execute(context.Background(), "nope", "SELECT 1;\nSET @x = 1;", 0, 0)
	if err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("USE failure must surface the driver error, got %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("no statement result may be produced when USE fails: %+v", results)
	}
	conn := (*created)[0]
	if len(conn.queries) != 0 || len(conn.execs) != 0 {
		t.Fatalf("statements must not run after a failed USE: execs=%+v queries=%+v", conn.execs, conn.queries)
	}
}

func TestMysqlExecuteEmptyScript(t *testing.T) {
	c, _ := newFakeMysqlClient(t, nil)
	if _, err := c.Execute(context.Background(), "app", "  \n ", 0, 0); err == nil || !strings.Contains(err.Error(), "没有可执行的 SQL 语句") {
		t.Fatalf("empty script must be rejected, got %v", err)
	}
}

// --- Execute:服务端分页(包装查询 + COUNT 计数 / SHOW 类截断回退) ---

// TestMysqlExecutePagedWrapsSelect 锁定包装分页契约:SELECT 语句被改写为
// `SELECT * FROM (<原文>) _dbp LIMIT n OFFSET m` 取页,同一连接再跑
// `SELECT COUNT(*) FROM (<原文>) _dbp` 计数,res.SQL 保持用户原文。
func TestMysqlExecutePagedWrapsSelect(t *testing.T) {
	conn := &fakeMysqlDrvConn{
		queryRows: &fakeMysqlDrvRows{
			cols: []string{"id"},
			vals: [][]driver.Value{{int64(1)}, {int64(2)}},
		},
		countRows: &fakeMysqlDrvRows{
			cols: []string{"COUNT(*)"},
			vals: [][]driver.Value{{int64(1234)}},
		},
	}
	c, created := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app", "SELECT * FROM users", 500, 100)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	res := results[0]
	if res.Error != "" {
		t.Fatalf("statement must succeed, got %q", res.Error)
	}
	if res.SQL != "SELECT * FROM users" {
		t.Fatalf("res.SQL must keep the original text, got %q", res.SQL)
	}
	wantPage := "SELECT * FROM (SELECT * FROM users) _dbp LIMIT 500 OFFSET 100"
	wantCount := "SELECT COUNT(*) FROM (SELECT * FROM users) _dbp"
	if len(conn.queries) != 2 || conn.queries[0] != wantPage || conn.queries[1] != wantCount {
		t.Fatalf("paged queries mismatch:\n got %+v\nwant [%q %q]", conn.queries, wantPage, wantCount)
	}
	if res.TotalRows == nil || *res.TotalRows != 1234 {
		t.Fatalf("total_rows must be the exact count 1234, got %+v", res.TotalRows)
	}
	if len(res.Rows) != 2 {
		t.Fatalf("unexpected rows: %+v", res.Rows)
	}
	if len(*created) != 1 {
		t.Fatalf("page and count must run on one connection, got %d", len(*created))
	}
}

// WITH 开头的语句同样可包装;尾分号去干净再进子查询。
func TestMysqlExecutePagedWrapsWithStatement(t *testing.T) {
	conn := &fakeMysqlDrvConn{
		countRows: &fakeMysqlDrvRows{cols: []string{"COUNT(*)"}, vals: [][]driver.Value{{int64(3)}}},
	}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app", "WITH c AS (SELECT 1) SELECT * FROM c;", 10, 5)
	if err != nil || results[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, results)
	}
	wantPage := "SELECT * FROM (WITH c AS (SELECT 1) SELECT * FROM c) _dbp LIMIT 10 OFFSET 5"
	if len(conn.queries) != 2 || conn.queries[0] != wantPage {
		t.Fatalf("WITH must be wrapped with LIMIT/OFFSET, got %+v", conn.queries)
	}
	if results[0].TotalRows == nil || *results[0].TotalRows != 3 {
		t.Fatalf("total_rows must come from the count query, got %+v", results[0].TotalRows)
	}
}

// SHOW/DESC/EXPLAIN 等不能包装的语句只消费 offset+limit 行:取满 limit 行
// total_rows=-1(结果可能未耗尽),本页跳过前 offset 行。
func TestMysqlExecutePagedShowTruncatesFullPage(t *testing.T) {
	conn := &fakeMysqlDrvConn{queryRows: &fakeMysqlDrvRows{
		cols: []string{"Tables_in_app"},
		vals: [][]driver.Value{{"a"}, {"b"}, {"c"}, {"d"}, {"e"}},
	}}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "", "SHOW TABLES", 2, 1)
	if err != nil || results[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, results)
	}
	res := results[0]
	// 原语句执行(无包装、无 COUNT),页数据从 offset 起共 limit 行。
	if len(conn.queries) != 1 || conn.queries[0] != "SHOW TABLES" {
		t.Fatalf("SHOW must run verbatim, got %+v", conn.queries)
	}
	if len(res.Rows) != 2 || res.Rows[0][0] == nil || *res.Rows[0][0] != "b" || *res.Rows[1][0] != "c" {
		t.Fatalf("page must start at offset 1 with 2 rows, got %+v", res.Rows)
	}
	if res.TotalRows == nil || *res.TotalRows != -1 {
		t.Fatalf("a full page must report total_rows -1, got %+v", res.TotalRows)
	}
}

// 结果集在 offset+limit 内耗尽时,total_rows = offset+本页行数(精确)。
func TestMysqlExecutePagedShowExhaustedTotal(t *testing.T) {
	conn := &fakeMysqlDrvConn{queryRows: &fakeMysqlDrvRows{
		cols: []string{"Tables_in_app"},
		vals: [][]driver.Value{{"a"}, {"b"}, {"c"}, {"d"}},
	}}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "", "SHOW TABLES", 2, 3)
	if err != nil || results[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, results)
	}
	res := results[0]
	if len(res.Rows) != 1 || res.Rows[0][0] == nil || *res.Rows[0][0] != "d" {
		t.Fatalf("page must hold the remaining 1 row, got %+v", res.Rows)
	}
	if res.TotalRows == nil || *res.TotalRows != 4 {
		t.Fatalf("exhausted result must report offset+pageLen=4, got %+v", res.TotalRows)
	}
}

// limit=0(或未传)保持旧行为:原语句执行、不下发 total_rows。
func TestMysqlExecuteWithoutLimitKeepsLegacyBehavior(t *testing.T) {
	conn := &fakeMysqlDrvConn{queryRows: &fakeMysqlDrvRows{
		cols: []string{"id"},
		vals: [][]driver.Value{{int64(1)}, {int64(2)}, {int64(3)}},
	}}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app", "SELECT * FROM users", 0, 0)
	if err != nil || results[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, results)
	}
	if len(conn.queries) != 1 || conn.queries[0] != "SELECT * FROM users" {
		t.Fatalf("statement must run verbatim without paging, got %+v", conn.queries)
	}
	if len(results[0].Rows) != 3 {
		t.Fatalf("all rows must be returned, got %+v", results[0].Rows)
	}
	if results[0].TotalRows != nil {
		t.Fatalf("total_rows must stay unset without paging, got %+v", results[0].TotalRows)
	}
}

// --- P1-2:分页包装丢失 ORDER BY ---

// 带顶层尾 ORDER BY 的 SELECT:外提到包装外层(派生表不保证保留子查询内的
// ORDER BY,跨页顺序可能不稳),外提片段按原文拼接。
func TestWrapMysqlPagedQueryHoistsTrailingOrderBy(t *testing.T) {
	got := wrapMysqlPagedQuery("SELECT * FROM users ORDER BY created_at DESC, id", 10, 5)
	want := "SELECT * FROM (SELECT * FROM users) _dbp ORDER BY created_at DESC, id LIMIT 10 OFFSET 5"
	if got != want {
		t.Fatalf("hoisted wrap = %q, want %q", got, want)
	}
}

// 尾巴带 LIMIT 的 ORDER BY 不外提(外提会改变语义),保持整句包装。
func TestWrapMysqlPagedQueryKeepsOrderByWithLimitTail(t *testing.T) {
	got := wrapMysqlPagedQuery("SELECT * FROM users ORDER BY created_at LIMIT 20", 10, 0)
	want := "SELECT * FROM (SELECT * FROM users ORDER BY created_at LIMIT 20) _dbp LIMIT 10 OFFSET 0"
	if got != want {
		t.Fatalf("wrap with limit tail = %q, want %q", got, want)
	}
}

// 子查询内(括号深度>0)的 ORDER BY 不外提。
func TestWrapMysqlPagedQueryKeepsSubqueryOrderBy(t *testing.T) {
	got := wrapMysqlPagedQuery("SELECT * FROM (SELECT * FROM t ORDER BY id) s", 10, 0)
	want := "SELECT * FROM (SELECT * FROM (SELECT * FROM t ORDER BY id) s) _dbp LIMIT 10 OFFSET 0"
	if got != want {
		t.Fatalf("wrap with subquery order by = %q, want %q", got, want)
	}
}

// Execute 集成:页查询外提 ORDER BY,COUNT 仍包装原文(计数不需要排序)。
func TestMysqlExecutePagedHoistsTrailingOrderBy(t *testing.T) {
	conn := &fakeMysqlDrvConn{
		queryRows: &fakeMysqlDrvRows{cols: []string{"id"}, vals: [][]driver.Value{{int64(1)}}},
		countRows: &fakeMysqlDrvRows{cols: []string{"COUNT(*)"}, vals: [][]driver.Value{{int64(7)}}},
	}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app", "SELECT * FROM users ORDER BY created_at DESC", 10, 5)
	if err != nil || results[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, results)
	}
	wantPage := "SELECT * FROM (SELECT * FROM users) _dbp ORDER BY created_at DESC LIMIT 10 OFFSET 5"
	wantCount := "SELECT COUNT(*) FROM (SELECT * FROM users ORDER BY created_at DESC) _dbp"
	if len(conn.queries) != 2 || conn.queries[0] != wantPage || conn.queries[1] != wantCount {
		t.Fatalf("paged queries mismatch:\n got %+v\nwant [%q %q]", conn.queries, wantPage, wantCount)
	}
	if results[0].TotalRows == nil || *results[0].TotalRows != 7 {
		t.Fatalf("total_rows must come from the count query, got %+v", results[0].TotalRows)
	}
}

// --- P2-2:负数分页参数钳制 ---

// limit<0 视为禁用分页(旧行为),offset<0 视为 0:语句原样执行、不下发
// total_rows,负数不得下溢到包装或截断逻辑。
func TestMysqlExecuteClampsNegativePaging(t *testing.T) {
	conn := &fakeMysqlDrvConn{queryRows: &fakeMysqlDrvRows{
		cols: []string{"id"},
		vals: [][]driver.Value{{int64(1)}, {int64(2)}, {int64(3)}},
	}}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app", "SELECT * FROM users", -1, -5)
	if err != nil || results[0].Error != "" {
		t.Fatalf("Execute: %v %+v", err, results)
	}
	if len(conn.queries) != 1 || conn.queries[0] != "SELECT * FROM users" {
		t.Fatalf("negative paging must disable wrapping, got %+v", conn.queries)
	}
	if len(results[0].Rows) != 3 {
		t.Fatalf("all rows must be returned, got %+v", results[0].Rows)
	}
	if results[0].TotalRows != nil {
		t.Fatalf("total_rows must stay unset without paging, got %+v", results[0].TotalRows)
	}
}

// --- 单表 SELECT 表名解析(Execute 附带 primary_key 的判定基础) ---

func TestSingleTableName(t *testing.T) {
	cases := []struct {
		sql    string
		schema string
		table  string
		ok     bool
	}{
		{"SELECT * FROM users", "", "users", true},
		{"select id, name from app.users where id = 1 order by name limit 10", "app", "users", true},
		{"SELECT * FROM `my db`.`user table`", "my db", "user table", true},
		{"SELECT * FROM `orders`", "", "orders", true},
		{"SELECT * FROM users u WHERE u.id = 1", "", "users", true},
		{"SELECT * FROM users AS u GROUP BY id HAVING count(*) > 1", "", "users", true},
		{"SELECT COUNT(*) FROM users", "", "users", true},
		{"SELECT a, (SELECT max(id) FROM logs) AS m FROM users", "", "users", true},
		{"SELECT 'FROM x' FROM users", "", "users", true},
		{"SELECT * FROM users;", "", "users", true},
		{"  select\n *\n from\n t\n", "", "t", true},
		// 多表/复合/非 SELECT/无法解析一律不判定。
		{"SELECT * FROM a JOIN b ON a.id = b.id", "", "", false},
		{"SELECT * FROM a LEFT JOIN b ON a.id = b.id", "", "", false},
		{"SELECT * FROM a, b", "", "", false},
		{"SELECT * FROM (SELECT 1) t", "", "", false},
		{"SELECT * FROM a UNION SELECT * FROM b", "", "", false},
		{"WITH c AS (SELECT 1) SELECT * FROM c", "", "", false},
		{"UPDATE users SET a = 1", "", "", false},
		{"INSERT INTO users VALUES (1)", "", "", false},
		{"SELECT 1", "", "", false},
		{"SELECT * FROM", "", "", false},
		{"SELECT * FROM t WHERE x = ?", "", "", false},
	}
	for _, tc := range cases {
		schema, table, ok := singleTableName(tc.sql)
		if ok != tc.ok || schema != tc.schema || table != tc.table {
			t.Errorf("singleTableName(%q) = (%q, %q, %v), want (%q, %q, %v)",
				tc.sql, schema, table, ok, tc.schema, tc.table, tc.ok)
		}
	}
}

// --- Execute:单表 SELECT 结果附带 primary_key ---

func TestMysqlExecuteFillsPrimaryKeyForSingleTableSelect(t *testing.T) {
	conn := &fakeMysqlDrvConn{pkByTable: map[string][]string{"app.users": {"id", "tenant_id"}}}
	c, created := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app", "SELECT * FROM users", 0, 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %+v", results)
	}
	res := results[0]
	if res.Error != "" {
		t.Fatalf("statement must succeed, got error %q", res.Error)
	}
	if !reflect.DeepEqual(res.PrimaryKey, []string{"id", "tenant_id"}) {
		t.Fatalf("primary key must be filled in ordinal order, got %+v", res.PrimaryKey)
	}
	// 未限定表名按当前库解析;主键查询与语句同连接。
	if len(conn.pkArgs) != 1 || len(conn.pkArgs[0]) != 2 ||
		conn.pkArgs[0][0] != "app" || conn.pkArgs[0][1] != "users" {
		t.Fatalf("pk lookup args must be (app, users), got %+v", conn.pkArgs)
	}
	if len(*created) != 1 {
		t.Fatalf("pk lookup must run on the statement connection, got %d conns", len(*created))
	}
}

func TestMysqlExecuteQualifiedTableUsesSQLSchema(t *testing.T) {
	conn := &fakeMysqlDrvConn{pkByTable: map[string][]string{"other.users": {"uid"}}}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app", "SELECT * FROM other.users", 0, 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !reflect.DeepEqual(results[0].PrimaryKey, []string{"uid"}) {
		t.Fatalf("qualified table must resolve its own schema, got %+v", results[0].PrimaryKey)
	}
	if len(conn.pkArgs) != 1 || conn.pkArgs[0][0] != "other" || conn.pkArgs[0][1] != "users" {
		t.Fatalf("pk lookup args must be (other, users), got %+v", conn.pkArgs)
	}
}

func TestMysqlExecuteUnqualifiedTableFallsBackToDefaultDB(t *testing.T) {
	conn := &fakeMysqlDrvConn{pkByTable: map[string][]string{"app.users": {"id"}}}
	c, _ := newFakeMysqlClient(t, conn)
	c.defaultDB = "app"
	results, err := c.Execute(context.Background(), "", "SELECT * FROM users", 0, 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !reflect.DeepEqual(results[0].PrimaryKey, []string{"id"}) {
		t.Fatalf("unqualified table must fall back to the connection default db, got %+v", results[0].PrimaryKey)
	}
	if len(conn.pkArgs) != 1 || conn.pkArgs[0][0] != "app" || conn.pkArgs[0][1] != "users" {
		t.Fatalf("pk lookup args must be (app, users), got %+v", conn.pkArgs)
	}
}

func TestMysqlExecuteLeavesPrimaryKeyEmptyForNonSingleTable(t *testing.T) {
	conn := &fakeMysqlDrvConn{pkByTable: map[string][]string{"app.users": {"id"}}}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app",
		"SELECT * FROM a JOIN b ON a.id = b.id; SELECT 1; UPDATE t SET a = 1", 0, 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %+v", results)
	}
	for i, res := range results {
		if len(res.PrimaryKey) != 0 {
			t.Fatalf("result %d must not carry primary key, got %+v", i, res.PrimaryKey)
		}
	}
	if len(conn.pkArgs) != 0 {
		t.Fatalf("non single-table statements must not trigger information_schema lookups, got %+v", conn.pkArgs)
	}
}

func TestMysqlExecutePrimaryKeyLookupFailureDoesNotAffectResult(t *testing.T) {
	conn := &fakeMysqlDrvConn{pkErr: errors.New("information_schema unavailable")}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app", "SELECT * FROM users", 0, 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	res := results[0]
	if res.Error != "" {
		t.Fatalf("statement must succeed regardless of pk lookup failure, got %q", res.Error)
	}
	if len(res.Columns) == 0 {
		t.Fatalf("statement columns must survive, got %+v", res.Columns)
	}
	if len(res.PrimaryKey) != 0 {
		t.Fatalf("pk lookup failure must leave primary key empty, got %+v", res.PrimaryKey)
	}
}

func TestMysqlExecuteTableWithoutPrimaryKeyLeavesEmpty(t *testing.T) {
	conn := &fakeMysqlDrvConn{pkByTable: map[string][]string{"app.logs": nil}}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app", "SELECT * FROM logs", 0, 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if results[0].Error != "" {
		t.Fatalf("statement must succeed, got %q", results[0].Error)
	}
	if len(results[0].PrimaryKey) != 0 {
		t.Fatalf("pk-less table must leave primary key empty, got %+v", results[0].PrimaryKey)
	}
}

func TestMysqlExecutePerStatementPrimaryKey(t *testing.T) {
	conn := &fakeMysqlDrvConn{pkByTable: map[string][]string{
		"app.users":  {"id"},
		"app.orders": {"order_id"},
	}}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app",
		"SELECT * FROM users; INSERT INTO logs(msg) VALUES ('hi'); SELECT * FROM orders", 0, 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %+v", results)
	}
	if !reflect.DeepEqual(results[0].PrimaryKey, []string{"id"}) {
		t.Fatalf("users select must carry its pk, got %+v", results[0].PrimaryKey)
	}
	if len(results[1].PrimaryKey) != 0 {
		t.Fatalf("insert must not carry primary key, got %+v", results[1].PrimaryKey)
	}
	if !reflect.DeepEqual(results[2].PrimaryKey, []string{"order_id"}) {
		t.Fatalf("orders select must carry its own pk, got %+v", results[2].PrimaryKey)
	}
}

// --- 纯函数:单元格时间格式化 ---

// TestFormatMysqlCell 验证 MySQL 单元格的时间按本地墙钟文本输出:DATETIME/
// TIMESTAMP 形如 "2026-09-24 14:52:30",DATE 只保留日期;不再走 FormatCHCell
// 的 RFC3339(T 分隔符 + 时区后缀)。其余类型委托 FormatCHCell 保持原行为。
func TestFormatMysqlCell(t *testing.T) {
	ts := time.Date(2026, 9, 24, 14, 52, 30, 0, time.Local)
	date := time.Date(2026, 9, 24, 0, 0, 0, 0, time.Local)
	cases := []struct {
		name    string
		in      any
		colType string
		want    *string
	}{
		{"datetime 去掉 T 与时区", ts, "DATETIME", strPtrOf("2026-09-24 14:52:30")},
		{"timestamp 同 datetime", ts, "TIMESTAMP", strPtrOf("2026-09-24 14:52:30")},
		{"列类型小写兼容", ts, "datetime", strPtrOf("2026-09-24 14:52:30")},
		{"date 只保留日期", date, "DATE", strPtrOf("2026-09-24")},
		{"列类型未知时按 datetime 布局", ts, "", strPtrOf("2026-09-24 14:52:30")},
		{"nil 保持 NULL", nil, "DATETIME", nil},
		{"字符串原样透传", "2026-09-24T14:52:30+08:00", "DATETIME", strPtrOf("2026-09-24T14:52:30+08:00")},
		{"数值走 FormatCHCell", int64(7), "BIGINT", strPtrOf("7")},
		{"bit 一个字节 1", []byte{0x01}, "BIT", strPtrOf("1")},
		{"bit 一个字节 0", []byte{0x00}, "BIT", strPtrOf("0")},
		{"bit 多字节大端累计", []byte{0x00, 0x2A}, "BIT", strPtrOf("42")},
		{"bit 空字节按 0", []byte{}, "BIT", strPtrOf("0")},
		{"bit 列类型小写兼容", []byte{0x01}, "bit(8)", strPtrOf("1")},
		{"非 bit 列的 bytes 原样转字符串", []byte{0x41}, "", strPtrOf("A")},
	}
	for _, tc := range cases {
		got := formatMysqlCell(tc.in, tc.colType, CHCellMaxBytes)
		switch {
		case tc.want == nil && got != nil:
			t.Fatalf("%s: got %q, want NULL", tc.name, *got)
		case tc.want != nil && got == nil:
			t.Fatalf("%s: got NULL, want %q", tc.name, *tc.want)
		case tc.want != nil && *got != *tc.want:
			t.Fatalf("%s: got %q, want %q", tc.name, *got, *tc.want)
		}
	}
}

// TestCollectMysqlRowsFormatsDateTime 验证控制台/表浏览共用的行收集按列类型
// 格式化单元格:DATETIME 输出 "YYYY-MM-DD HH:MM:SS",DATE 只保留日期,BIT 的
// 原始位字节渲染为十进制,NULL 仍为 nil;前端拿到的即最终文本,无需二次处理。
func TestCollectMysqlRowsFormatsDateTime(t *testing.T) {
	conn := &fakeMysqlDrvConn{queryRows: &fakeMysqlDrvRows{
		cols:  []string{"created_at", "birthday", "enable", "name"},
		types: []string{"DATETIME", "DATE", "BIT", "VARCHAR"},
		vals: [][]driver.Value{
			{
				time.Date(2026, 9, 24, 14, 52, 30, 0, time.Local),
				time.Date(2026, 9, 24, 0, 0, 0, 0, time.Local),
				[]byte{0x01},
				"张三",
			},
			{nil, nil, []byte{0x00}, nil},
		},
	}}
	c, _ := newFakeMysqlClient(t, conn)
	results, err := c.Execute(context.Background(), "app", "SELECT created_at, birthday, enable, name FROM users", 0, 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	res := results[0]
	if res.Error != "" {
		t.Fatalf("statement must succeed, got %q", res.Error)
	}
	wantTypes := []string{"DATETIME", "DATE", "BIT", "VARCHAR"}
	for i, col := range res.Columns {
		if col.Type != wantTypes[i] {
			t.Fatalf("column %d type = %q, want %q", i, col.Type, wantTypes[i])
		}
	}
	wantRows := [][]*string{
		{strPtrOf("2026-09-24 14:52:30"), strPtrOf("2026-09-24"), strPtrOf("1"), strPtrOf("张三")},
		{nil, nil, strPtrOf("0"), nil},
	}
	if !reflect.DeepEqual(res.Rows, wantRows) {
		t.Fatalf("rows must be wall-clock formatted, got %+v", res.Rows)
	}
}
