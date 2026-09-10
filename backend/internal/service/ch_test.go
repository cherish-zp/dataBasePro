package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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
	// 单元格更新能力(可选):记录委托参数并回放预设结果。
	previewOut  model.CHCellUpdatePreview
	previewCall chCellUpdateCall
	updateCall  chCellUpdateCall
	updateErr   error
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

// --- 单元格更新:fake 增加能力 + Service 委托 ---

// chCellUpdateCall records the arguments of one cell-update delegation.
type chCellUpdateCall struct {
	database, table string
	set             model.CHCellValue
	where           []model.CHCellValue
}

func (f *fakeCH) PreviewCellUpdate(_ context.Context, database, table string, set model.CHCellValue, where []model.CHCellValue) (model.CHCellUpdatePreview, error) {
	f.previewCall = chCellUpdateCall{database: database, table: table, set: set, where: where}
	return f.previewOut, nil
}

func (f *fakeCH) UpdateCell(_ context.Context, database, table string, set model.CHCellValue, where []model.CHCellValue) error {
	f.updateCall = chCellUpdateCall{database: database, table: table, set: set, where: where}
	return f.updateErr
}

// TestServiceCHCellUpdateDelegates 锁定 Service 层委托:参数透传、结果与错误透传。
func TestServiceCHCellUpdateDelegates(t *testing.T) {
	fake := &fakeCH{
		previewOut: model.CHCellUpdatePreview{
			Statement:   "ALTER TABLE `logs`.`events` UPDATE `note` = 'x' WHERE `id` = 1 SETTINGS mutations_sync = 1",
			MatchedRows: 2,
		},
	}
	svc, id := newTestServiceWithCH(t, fake)
	ctx := context.Background()
	set := model.CHCellValue{Column: "note", Type: "String", Value: strP("x")}
	where := []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1")}}

	prev, err := svc.CHPreviewCellUpdate(ctx, id, "logs", "events", set, where)
	if err != nil || prev.MatchedRows != 2 || prev.Statement != fake.previewOut.Statement {
		t.Fatalf("CHPreviewCellUpdate: %v %+v", err, prev)
	}
	if fake.previewCall.database != "logs" || fake.previewCall.table != "events" ||
		fake.previewCall.set.Column != "note" || len(fake.previewCall.where) != 1 {
		t.Fatalf("preview args must pass through: %+v", fake.previewCall)
	}

	if err := svc.CHUpdateCell(ctx, id, "logs", "events", set, where); err != nil {
		t.Fatalf("CHUpdateCell: %v", err)
	}
	if fake.updateCall.database != "logs" || fake.updateCall.table != "events" || fake.updateCall.set.Column != "note" {
		t.Fatalf("update args must pass through: %+v", fake.updateCall)
	}

	fake.updateErr = errors.New("boom")
	if err := svc.CHUpdateCell(ctx, id, "logs", "events", set, where); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("update error must surface, got %v", err)
	}
}

// legacyCH 模拟旧池化客户端:方法集只有 ClickHouseDataSource,没有单元格
// 更新能力 —— 必须得到明确错误而非 panic。
type legacyCH struct{ ClickHouseDataSource }

func TestServiceCHCellUpdateRejectsLegacyClient(t *testing.T) {
	svc, id := newTestServiceWithCH(t, &fakeCH{})
	if err := svc.pool.Put(id, &legacyCH{&fakeCH{}}); err != nil {
		t.Fatalf("pool put: %v", err)
	}
	ctx := context.Background()
	set := model.CHCellValue{Column: "note", Type: "String", Value: strP("x")}
	where := []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1")}}
	if _, err := svc.CHPreviewCellUpdate(ctx, id, "logs", "events", set, where); err == nil {
		t.Fatal("legacy client must be rejected on preview")
	}
	if err := svc.CHUpdateCell(ctx, id, "logs", "events", set, where); err == nil {
		t.Fatal("legacy client must be rejected on update")
	}
}

// --- 单元格更新:语句构造(纯函数) ---

func TestBuildCHCellUpdateStatement(t *testing.T) {
	cases := []struct {
		name  string
		db    string
		table string
		set   model.CHCellValue
		where []model.CHCellValue
		want  string
	}{
		{
			"numeric literals stay unquoted",
			"logs", "events",
			model.CHCellValue{Column: "cnt", Type: "UInt64", Value: strP("42")},
			[]model.CHCellValue{{Column: "id", Type: "Int32", Value: strP("-3")}},
			"ALTER TABLE `logs`.`events` UPDATE `cnt` = 42 WHERE `id` = -3 SETTINGS mutations_sync = 1",
		},
		{
			"float and decimal literals stay unquoted",
			"logs", "events",
			model.CHCellValue{Column: "ratio", Type: "Float64", Value: strP("3.14")},
			[]model.CHCellValue{{Column: "amount", Type: "Decimal(10, 2)", Value: strP("12.34")}},
			"ALTER TABLE `logs`.`events` UPDATE `ratio` = 3.14 WHERE `amount` = 12.34 SETTINGS mutations_sync = 1",
		},
		{
			"string literals escape quote and backslash",
			"logs", "events",
			model.CHCellValue{Column: "note", Type: "String", Value: strP("it's")},
			[]model.CHCellValue{{Column: "path", Type: "String", Value: strP(`a\b`)}},
			"ALTER TABLE `logs`.`events` UPDATE `note` = 'it\\'s' WHERE `path` = 'a\\\\b' SETTINGS mutations_sync = 1",
		},
		{
			"date/datetime/uuid/enum/ipv quote as strings",
			"logs", "events",
			model.CHCellValue{Column: "day", Type: "Date", Value: strP("2026-09-10")},
			[]model.CHCellValue{
				{Column: "ts", Type: "DateTime64(3)", Value: strP("2026-09-10 00:00:00")},
				{Column: "uid", Type: "UUID", Value: strP("6082f809-90b0-42c6-9b40-4f3ba0e1a2d1")},
				{Column: "level", Type: "Enum8('low' = 1, 'high' = 2)", Value: strP("low")},
				{Column: "ip", Type: "IPv4", Value: strP("1.2.3.4")},
			},
			"ALTER TABLE `logs`.`events` UPDATE `day` = '2026-09-10' WHERE `ts` = '2026-09-10 00:00:00' AND `uid` = '6082f809-90b0-42c6-9b40-4f3ba0e1a2d1' AND `level` = 'low' AND `ip` = '1.2.3.4' SETTINGS mutations_sync = 1",
		},
		{
			"unknown type falls back to quoted string",
			"logs", "events",
			model.CHCellValue{Column: "city", Type: "LowCardinality(String)", Value: strP("bj")},
			[]model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1")}},
			"ALTER TABLE `logs`.`events` UPDATE `city` = 'bj' WHERE `id` = 1 SETTINGS mutations_sync = 1",
		},
		{
			"nullable column accepts NULL",
			"logs", "events",
			model.CHCellValue{Column: "note", Type: "Nullable(String)", Value: nil},
			[]model.CHCellValue{{Column: "k", Type: "UInt64", Value: strP("1")}},
			"ALTER TABLE `logs`.`events` UPDATE `note` = NULL WHERE `k` = 1 SETTINGS mutations_sync = 1",
		},
		{
			"nullable where value becomes IS NULL",
			"logs", "events",
			model.CHCellValue{Column: "note", Type: "String", Value: strP("x")},
			[]model.CHCellValue{
				{Column: "k", Type: "UInt64", Value: strP("1")},
				{Column: "ts", Type: "Nullable(DateTime)", Value: nil},
			},
			"ALTER TABLE `logs`.`events` UPDATE `note` = 'x' WHERE `k` = 1 AND `ts` IS NULL SETTINGS mutations_sync = 1",
		},
		{
			"identifiers escape embedded backticks",
			"d`b", "we`ird",
			model.CHCellValue{Column: "col`x", Type: "UInt64", Value: strP("1")},
			[]model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1")}},
			"ALTER TABLE `d``b`.`we``ird` UPDATE `col``x` = 1 WHERE `id` = 1 SETTINGS mutations_sync = 1",
		},
	}
	for _, tc := range cases {
		got, err := buildCHCellUpdateStatement(tc.db, tc.table, tc.set, tc.where)
		if err != nil {
			t.Fatalf("%s: unexpected error %v", tc.name, err)
		}
		if got != tc.want {
			t.Fatalf("%s:\n got %q\nwant %q", tc.name, got, tc.want)
		}
	}
}

func TestBuildCHCellUpdateStatementErrors(t *testing.T) {
	where1 := []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1")}}
	setOK := model.CHCellValue{Column: "note", Type: "String", Value: strP("x")}
	cases := []struct {
		name    string
		set     model.CHCellValue
		where   []model.CHCellValue
		wantErr string
	}{
		{"numeric set with unparseable value", model.CHCellValue{Column: "cnt", Type: "UInt64", Value: strP("abc")}, where1, "数值"},
		{"numeric set with empty value", model.CHCellValue{Column: "cnt", Type: "Int64", Value: strP("")}, where1, "数值"},
		{"numeric where with injection-ish text", setOK, []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1; DROP")}}, "数值"},
		{"nil value on non-nullable set column", model.CHCellValue{Column: "note", Type: "String", Value: nil}, where1, "不可为 NULL"},
		{"nil value on non-nullable where column", setOK, []model.CHCellValue{{Column: "ts", Type: "DateTime", Value: nil}}, "不可为 NULL"},
		{"empty where rejects full-table update", setOK, nil, "where"},
		{"empty set column", model.CHCellValue{Type: "UInt64", Value: strP("1")}, where1, "set"},
	}
	for _, tc := range cases {
		got, err := buildCHCellUpdateStatement("logs", "events", tc.set, tc.where)
		if err == nil {
			t.Fatalf("%s: expected error, got statement %q", tc.name, got)
		}
		if !strings.Contains(err.Error(), tc.wantErr) {
			t.Fatalf("%s: error %q must mention %q", tc.name, err, tc.wantErr)
		}
	}
}

// --- 单元格更新:预览/执行走 fake CH HTTP server ---

func TestCHHTTPDriverPreviewCellUpdate(t *testing.T) {
	var countSQL string
	cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sqlText := string(body)
		switch {
		case strings.Contains(sqlText, "SELECT 1"):
			io.WriteString(w, "1")
		case strings.Contains(sqlText, "SELECT count()"):
			countSQL = sqlText
			io.WriteString(w, `["count()"]
["UInt64"]
[3]`)
		default:
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, "unexpected query: "+sqlText)
		}
	})
	set := model.CHCellValue{Column: "note", Type: "String", Value: strP("it's")}
	where := []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("7")}}
	prev, err := cl.PreviewCellUpdate(context.Background(), "logs", "events", set, where)
	if err != nil {
		t.Fatalf("PreviewCellUpdate: %v", err)
	}
	want := "ALTER TABLE `logs`.`events` UPDATE `note` = 'it\\'s' WHERE `id` = 7 SETTINGS mutations_sync = 1"
	if prev.Statement != want {
		t.Fatalf("statement = %q, want %q", prev.Statement, want)
	}
	if prev.MatchedRows != 3 {
		t.Fatalf("matched_rows = %d, want 3", prev.MatchedRows)
	}
	if !strings.Contains(countSQL, "SELECT count() FROM `logs`.`events` WHERE `id` = 7") {
		t.Fatalf("count sql must reuse the same WHERE, got %q", countSQL)
	}
}

func TestCHHTTPDriverUpdateCellExecutesMutation(t *testing.T) {
	var execSQL string
	cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sqlText := string(body)
		if strings.Contains(sqlText, "ALTER TABLE") {
			execSQL = sqlText
			io.WriteString(w, "")
			return
		}
		io.WriteString(w, "1")
	})
	set := model.CHCellValue{Column: "cnt", Type: "UInt64", Value: strP("42")}
	where := []model.CHCellValue{
		{Column: "id", Type: "UInt64", Value: strP("7")},
		{Column: "day", Type: "Date", Value: strP("2026-09-10")},
	}
	if err := cl.UpdateCell(context.Background(), "logs", "events", set, where); err != nil {
		t.Fatalf("UpdateCell: %v", err)
	}
	want := "ALTER TABLE `logs`.`events` UPDATE `cnt` = 42 WHERE `id` = 7 AND `day` = '2026-09-10' SETTINGS mutations_sync = 1"
	if execSQL != want {
		t.Fatalf("exec sql = %q, want %q", execSQL, want)
	}
	if !strings.Contains(execSQL, "SETTINGS mutations_sync = 1") {
		t.Fatalf("mutation must run synchronously, got %q", execSQL)
	}
}

// 空库名必须落到连接配置的默认库。
func TestCHHTTPDriverUpdateCellUsesConfiguredDefaultDatabase(t *testing.T) {
	var execSQL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sqlText := string(body)
		if strings.Contains(sqlText, "ALTER TABLE") {
			execSQL = sqlText
			io.WriteString(w, "")
			return
		}
		io.WriteString(w, "1")
	}))
	t.Cleanup(srv.Close)
	cfg := model.ClickHouseConfig{
		Hosts:    []string{strings.TrimPrefix(srv.URL, "http://")},
		Username: "default",
		Database: "logs",
		Protocol: model.CHProtocolHTTP,
	}
	cl, err := NewCHClient(cfg)
	if err != nil {
		t.Fatalf("NewCHClient: %v", err)
	}
	t.Cleanup(func() { cl.Close() })
	set := model.CHCellValue{Column: "cnt", Type: "UInt64", Value: strP("1")}
	where := []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1")}}
	if err := cl.UpdateCell(context.Background(), "", "events", set, where); err != nil {
		t.Fatalf("UpdateCell: %v", err)
	}
	if !strings.Contains(execSQL, "ALTER TABLE `logs`.`events` UPDATE") {
		t.Fatalf("empty database must resolve to the configured default, got %q", execSQL)
	}
}

// --- PageRows 主键列(system.columns.is_in_primary_key,按 position 排序) ---

func TestCHHTTPDriverPageRowsPrimaryKey(t *testing.T) {
	cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sqlText := string(body)
		switch {
		case strings.Contains(sqlText, "SELECT 1"):
			io.WriteString(w, "1")
		case strings.Contains(sqlText, "system.tables"):
			io.WriteString(w, `["engine","total_rows"]
["String","UInt64"]
["MergeTree",5]`)
		case strings.Contains(sqlText, "system.columns"):
			io.WriteString(w, `["name","type","comment","is_in_primary_key"]
["String","String","String","UInt8"]
["id","UInt64","",1]
["name","String","用户名",0]`)
		default:
			io.WriteString(w, `["id","name"]
["UInt64","String"]
[1,"a"]`)
		}
	})
	res, err := cl.PageRows(context.Background(), "logs", "events", "", "", true, 10, 0)
	if err != nil {
		t.Fatalf("PageRows: %v", err)
	}
	if len(res.PrimaryKey) != 1 || res.PrimaryKey[0] != "id" {
		t.Fatalf("primary_key must follow is_in_primary_key in position order, got %#v", res.PrimaryKey)
	}
}

func TestCHHTTPDriverPageRowsNoPrimaryKey(t *testing.T) {
	// 两形:is_in_primary_key 全 0(无主键)与老响应缺该列,都必须落
	// 空(非 nil)数组,前端拿到 [] 而非 null。
	for _, colsJSON := range []string{
		`["name","type","comment","is_in_primary_key"]
["String","String","String","UInt8"]
["id","UInt64","",0]
["name","String","",0]`,
		`["name","type","comment"]
["String","String","String"]
["id","UInt64",""]
["name","String",""]`,
	} {
		cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			sqlText := string(body)
			switch {
			case strings.Contains(sqlText, "SELECT 1"):
				io.WriteString(w, "1")
			case strings.Contains(sqlText, "system.tables"):
				io.WriteString(w, `["engine","total_rows"]
["String","UInt64"]
["MergeTree",5]`)
			case strings.Contains(sqlText, "system.columns"):
				io.WriteString(w, colsJSON)
			default:
				io.WriteString(w, `["id","name"]
["UInt64","String"]
[1,"a"]`)
			}
		})
		res, err := cl.PageRows(context.Background(), "logs", "events", "", "", true, 10, 0)
		if err != nil {
			t.Fatalf("PageRows: %v", err)
		}
		if res.PrimaryKey == nil || len(res.PrimaryKey) != 0 {
			t.Fatalf("no primary key must yield empty non-nil array, got %#v", res.PrimaryKey)
		}
	}
}
