package service

import (
	"context"
	"errors"
	"strings"
	"testing"

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
	execSQL      string
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
func (f *fakeMysqlDS) Execute(_ context.Context, sqlText string) ([]model.MysqlStatementResult, error) {
	f.execSQL = sqlText
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
	if _, err := svc.MysqlExecute(ctx, c.ID, "SELECT 1"); err != nil || fake.execSQL != "SELECT 1" {
		t.Fatalf("MysqlExecute: %v sql=%q", err, fake.execSQL)
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
