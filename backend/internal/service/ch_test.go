package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/store"
)

// --- 纯函数:SplitSQLStatements ---

func TestSplitSQLStatements(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", nil},
		{"whitespace and stray semicolons only", "  \n\t ;;  ;\n", nil},
		{"single without trailing semicolon", "SELECT 1", []string{"SELECT 1"}},
		{"multiple trimmed", "SELECT 1;;\nSELECT 2 ;", []string{"SELECT 1", "SELECT 2"}},
		{
			"semicolon inside single quotes",
			"SELECT 'a;b', 'it''s;x' FROM t",
			[]string{"SELECT 'a;b', 'it''s;x' FROM t"},
		},
		{
			"backslash and doubled quote escapes in single quotes",
			`SELECT 'x\';y', 'z''w'`,
			[]string{`SELECT 'x\';y', 'z''w'`},
		},
		{
			"semicolon inside double quotes and backticks",
			"SELECT \"a;b\" FROM `tb`; CREATE TABLE `x;y` (id UInt64)",
			[]string{"SELECT \"a;b\" FROM `tb`", "CREATE TABLE `x;y` (id UInt64)"},
		},
		{
			"line comments stripped; trailing comment-only chunk dropped",
			"SELECT 1 -- keep;hidden\n; -- only a comment\nSELECT 2",
			[]string{"SELECT 1", "SELECT 2"},
		},
		{
			// "SELECT␣" + 注释折叠出的 1 个空格 + "␣1":注释保留词法边界。
			"block comments collapsed; statement preserved",
			"SELECT /* a;b */ 1; /* standalone;\ncomment */ ; INSERT INTO t VALUES (1)",
			[]string{"SELECT" + strings.Repeat(" ", 3) + "1", "INSERT INTO t VALUES (1)"},
		},
		{
			"unterminated string keeps rest verbatim",
			"SELECT 'a;b",
			[]string{"SELECT 'a;b"},
		},
	}
	for _, tc := range cases {
		got := SplitSQLStatements(tc.in)
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s: got %#v, want %#v", tc.name, got, tc.want)
		}
	}
}

// --- 纯函数:FormatCHCell ---

func TestFormatCHCell(t *testing.T) {
	ts := time.Date(2026, 9, 9, 10, 20, 30, 0, time.UTC)

	cases := []struct {
		name string
		in   any
		want *string
	}{
		{"nil is NULL", nil, nil},
		{"string", "hello", strP("hello")},
		{"bytes", []byte("raw"), strP("raw")},
		{"bool", true, strP("true")},
		{"int64", int64(42), strP("42")},
		{"int", int(7), strP("7")},
		{"uint64", uint64(18446744073709551615), strP("18446744073709551615")},
		{"float64", 3.14, strP("3.14")},
		{"float32", float32(1.5), strP("1.5")},
		{"time RFC3339", ts, strP("2026-09-09T10:20:30Z")},
		{"fallback %v", []string{"a", "b"}, strP("[a b]")},
	}
	for _, tc := range cases {
		got := FormatCHCell(tc.in, 8192)
		if tc.want == nil || got == nil {
			if (tc.want == nil) != (got == nil) {
				t.Fatalf("%s: got %v, want %v", tc.name, got, tc.want)
			}
			continue
		}
		if *got != *tc.want {
			t.Fatalf("%s: got %q, want %q", tc.name, *got, *tc.want)
		}
	}
}

func TestFormatCHCellTruncates(t *testing.T) {
	long := strings.Repeat("x", 100)
	got := FormatCHCell(long, 10)
	if got == nil {
		t.Fatal("expected a value")
	}
	if *got != strings.Repeat("x", 10)+"…(截断)" {
		t.Fatalf("truncated cell = %q", *got)
	}
	// 恰好等于阈值不截断。
	got = FormatCHCell(strings.Repeat("y", 10), 10)
	if *got != strings.Repeat("y", 10) {
		t.Fatalf("boundary cell = %q", *got)
	}
	// maxBytes<=0 不截断。
	got = FormatCHCell(long, 0)
	if *got != long {
		t.Fatalf("unbounded cell = %q", *got)
	}
}

func strP(s string) *string { return &s }

// --- NewCHClient 配置校验(不触网) ---

func TestNewCHClientRejectsInvalidConfig(t *testing.T) {
	if _, err := NewCHClient(model.ClickHouseConfig{Hosts: []string{"no-port"}}); err == nil {
		t.Fatal("invalid host must be rejected before dialing")
	}
	if _, err := NewCHClient(model.ClickHouseConfig{}); err == nil {
		t.Fatal("empty hosts must be rejected before dialing")
	}
}

// --- buildCHOptions 协议组装(不触网) ---

func TestBuildCHOptionsProtocol(t *testing.T) {
	// http → clickhouse.HTTP;Auth/TLS/超时按配置组装。
	cfg := model.ClickHouseConfig{
		Hosts:    []string{"ch-1:8123"},
		Username: "ops",
		Password: "p",
		Database: "logs",
		TLS:      true,
		Protocol: model.CHProtocolHTTP,
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	opt := buildCHOptions(cfg)
	if opt.Protocol != clickhouse.HTTP {
		t.Fatalf("protocol %q must map to clickhouse.HTTP, got %v", model.CHProtocolHTTP, opt.Protocol)
	}
	if opt.Addr[0] != "ch-1:8123" || opt.Auth.Username != "ops" || opt.Auth.Password != "p" || opt.Auth.Database != "logs" {
		t.Fatalf("unexpected options: %+v", opt)
	}
	if opt.TLS == nil || opt.TLS.ServerName != "ch-1" {
		t.Fatalf("TLS must keep ServerName from first host, got %+v", opt.TLS)
	}
	if opt.DialTimeout != chDialTimeout {
		t.Fatalf("unexpected dial timeout: %v", opt.DialTimeout)
	}

	// native(含空值归一)→ clickhouse.Native,未开 TLS 则不带 TLS。
	cfg = model.ClickHouseConfig{Hosts: []string{"ch-1:9000"}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	opt = buildCHOptions(cfg)
	if opt.Protocol != clickhouse.Native {
		t.Fatalf("protocol native must map to clickhouse.Native, got %v", opt.Protocol)
	}
	if opt.TLS != nil {
		t.Fatalf("TLS must stay off without cfg.TLS, got %+v", opt.TLS)
	}
}

// --- wrapCHPingError 提示(纯函数) ---

func TestWrapCHPingError(t *testing.T) {
	// 原生协议打到 HTTP 端口:错误含 unexpected packet → 追加切换协议提示。
	err := wrapCHPingError(errors.New("[handshake] unexpected packet [72] from server"))
	if err == nil {
		t.Fatal("expected wrapped error")
	}
	for _, want := range []string{"clickhouse ping: ", "unexpected packet", "HTTP", "8123", "9000"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q must mention %q", err, want)
		}
	}

	// 普通网络错误 → 不追加提示。
	plain := wrapCHPingError(errors.New("connection refused"))
	if !strings.Contains(plain.Error(), "connection refused") || strings.Contains(plain.Error(), "8123") {
		t.Fatalf("plain error must wrap without the HTTP hint, got %q", plain.Error())
	}
}

// --- Service 层:池化 + 委托(fake 注入,不触网) ---

// fakeCH implements ClickHouseDataSource for service/app-layer tests.
type fakeCH struct {
	fakeDataSource
	dbs        []string
	tables     []model.CHTableInfo
	page       model.CHPageRowsResult
	pageCall   string
	truncated  string
	clusterArg bool
	execSQL    string
	execResult []model.CHStatementResult
}

func (f *fakeCH) Databases(context.Context) ([]string, error) { return f.dbs, nil }

func (f *fakeCH) Tables(_ context.Context, database string, showSystem bool) ([]model.CHTableInfo, error) {
	f.pageCall = "tables:" + database
	_ = showSystem
	return f.tables, nil
}

func (f *fakeCH) PageRows(_ context.Context, database, table, _, _ string, _ bool, _, _ int) (model.CHPageRowsResult, error) {
	f.pageCall = database + "." + table
	return f.page, nil
}

func (f *fakeCH) TruncateTable(_ context.Context, database, table string, onCluster bool) error {
	f.truncated = database + "." + table
	f.clusterArg = onCluster
	return nil
}

func (f *fakeCH) Execute(_ context.Context, sqlText string) ([]model.CHStatementResult, error) {
	f.execSQL = sqlText
	return f.execResult, nil
}

// newTestServiceWithCH wires a service against a store holding one clickhouse
// connection whose pooled client is the given fake (no network involved).
func newTestServiceWithCH(t *testing.T, fake *fakeCH) (*Service, string) {
	t.Helper()
	st, err := store.Open(t.TempDir()+"/config.db", "test-master")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	svc := NewService(st, &fakeFactory{k: &fakeKafka{}})
	ctx := context.Background()
	c := &model.Connection{
		ID:     "conn-ch",
		Name:   "ch-local",
		Type:   model.ConnectionTypeClickHouse,
		Config: model.MustConfigJSON(model.ClickHouseConfig{Hosts: []string{"127.0.0.1:9000"}}),
	}
	if _, err := svc.CreateConnection(ctx, c); err != nil {
		t.Fatalf("create clickhouse connection: %v", err)
	}
	if err := svc.pool.Put(c.ID, fake); err != nil {
		t.Fatalf("pool put fake: %v", err)
	}
	return svc, c.ID
}

func TestServiceCHDelegates(t *testing.T) {
	wantRows := int64(12)
	page := model.CHPageRowsResult{
		Columns:   []model.CHColumn{{Name: "id", Type: "UInt64"}},
		Rows:      [][]*string{{strP("1"), nil}},
		Engine:    "MergeTree",
		TotalRows: &wantRows,
	}
	stmts := []model.CHStatementResult{{SQL: "SELECT 1", DurationMs: 1}}
	fake := &fakeCH{
		dbs:        []string{"default", "logs"},
		tables:     []model.CHTableInfo{{Name: "events", Engine: "MergeTree", TotalRows: &wantRows}},
		page:       page,
		execResult: stmts,
	}
	svc, id := newTestServiceWithCH(t, fake)
	ctx := context.Background()

	dbs, err := svc.CHDatabases(ctx, id)
	if err != nil || len(dbs) != 2 || dbs[1] != "logs" {
		t.Fatalf("CHDatabases: %v %+v", err, dbs)
	}

	tables, err := svc.CHTables(ctx, id, "logs", false)
	if err != nil || len(tables) != 1 || tables[0].Name != "events" || tables[0].TotalRows == nil || *tables[0].TotalRows != 12 {
		t.Fatalf("CHTables: %v %+v", err, tables)
	}

	gotPage, err := svc.CHPageRows(ctx, id, "logs", "events", "x > 1", "id", true, 10, 20)
	if err != nil || gotPage.Engine != "MergeTree" || gotPage.TotalRows == nil || *gotPage.TotalRows != 12 {
		t.Fatalf("CHPageRows: %v %+v", err, gotPage)
	}
	if gotPage.Rows[0][1] != nil {
		t.Fatalf("NULL cell must stay nil: %+v", gotPage.Rows)
	}
	if fake.pageCall != "logs.events" {
		t.Fatalf("page must target db.table, got %q", fake.pageCall)
	}

	if err := svc.CHTruncateTable(ctx, id, "logs", "events", true); err != nil {
		t.Fatalf("CHTruncateTable: %v", err)
	}
	if fake.truncated != "logs.events" || !fake.clusterArg {
		t.Fatalf("truncate delegation mismatch: %+v", fake)
	}

	results, err := svc.CHExecute(ctx, id, "SELECT 1")
	if err != nil || len(results) != 1 || results[0].SQL != "SELECT 1" {
		t.Fatalf("CHExecute: %v %+v", err, results)
	}
	if fake.execSQL != "SELECT 1" {
		t.Fatalf("execute must delegate verbatim, got %q", fake.execSQL)
	}

	// 池化:再次调用复用同一 fake(池中仍是它)。
	if _, err := svc.CHDatabases(ctx, id); err != nil {
		t.Fatalf("second call: %v", err)
	}
}

func TestServiceCHWrongTypeInPool(t *testing.T) {
	svc, id := newTestServiceWithCH(t, &fakeCH{})
	// 用 Kafka fake 顶替,类型断言必须失败。
	_ = svc.pool.Put(id, &fakeKafka{})
	if _, err := svc.CHDatabases(context.Background(), id); err == nil {
		t.Fatal("a non-ClickHouse pooled client must be rejected")
	}
}

func TestServiceCHAutoConnectUnknownConnection(t *testing.T) {
	svc, _ := newTestServiceWithCH(t, &fakeCH{})
	if _, err := svc.CHDatabases(context.Background(), "nope"); err == nil {
		t.Fatal("unknown connection must fail")
	}
}

func TestServiceCHTestConnectionValidates(t *testing.T) {
	svc, _ := newTestServiceWithCH(t, &fakeCH{})
	if err := svc.CHTestConnection(context.Background(), model.ClickHouseConfig{Hosts: []string{"no-port"}}); err == nil {
		t.Fatal("invalid config must fail before dialing")
	}
}

// Ensure fakeCH satisfies the interface through the embedded fakeDataSource.
var _ ClickHouseDataSource = (*fakeCH)(nil)
